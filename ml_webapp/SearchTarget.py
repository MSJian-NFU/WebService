"""
search_snippets.py
- 支援檔案類型: .pdf, .txt, .log, .csv, .json, .docx
- 需要套件: numpy, pandas, jieba, pdfplumber, scikit-learn, python-docx
- 修改可調整項目：TARGET_FOLDER, OUTPUT_CSV, OUTPUT_XLSX, TARGET_FILE (target-search.txt)
"""

import os
import re
import json
import csv
import numpy as np
import pandas as pd
import jieba
import pdfplumber
from docx import Document
from sklearn.feature_extraction.text import CountVectorizer

# ==============================
# 可修改區：設定要搜尋的資料夾與輸出檔名
# ==============================
# 請修改下面的資料夾路徑為你的實際資料夾
TARGET_FOLDER = r"./uploads"            # <--- 這裡可改為實際放PDF/TXT/CSV/JSON/DOCX等檔案的資料夾
TARGET_RULE_FILE = "./uploads/target-search.txt"  # <--- 規則檔案 (A-B-C)
OUTPUT_DIR = "./output_st"
OUTPUT_CSV = "./output_st/search_results.csv"    # <--- 輸出 CSV 檔
OUTPUT_XLSX = "./output_st/search_results.xlsx"  # <--- 輸出 Excel 檔
# ==============================

# 支援副檔名
SUPPORTED_EXTS = {".pdf", ".txt", ".log", ".csv", ".json", ".docx"}

# ====== 初始化輸出資料夾：安全清空舊檔 ======
os.makedirs(OUTPUT_DIR, exist_ok=True)
for f in os.listdir(OUTPUT_DIR):
    try:
        os.remove(os.path.join(OUTPUT_DIR, f))
    except:
        pass


# 讀取 target-search.txt
def load_rules(rules_path):
    rules = []
    with open(rules_path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            raw = line.strip()
            if not raw:
                continue
            parts = raw.split("-")
            # allow A-B-C even if B empty (A--C)
            if len(parts) >= 3:
                A = parts[0].strip()
                B = parts[1].strip()
                try:
                    C = int(parts[2].strip())
                except Exception:
                    print(f"[警告] 第 {lineno} 行 C 非整數，使用預設 50")
                    C = 50
                rules.append((A, B, C))
            else:
                print(f"[忽略] 第 {lineno} 行格式錯誤: {raw}")
    return rules

# 將各類檔案內容抽成純文字 (string)
def extract_text_from_file(filepath):
    ext = os.path.splitext(filepath)[1].lower()
    try:
        if ext == ".txt" or ext == ".log":
            with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                return f.read()
        elif ext == ".pdf":
            texts = []
            with pdfplumber.open(filepath) as pdf:
                for page in pdf.pages:
                    page_text = page.extract_text()
                    if page_text:
                        texts.append(page_text)
            return "\n".join(texts)
        elif ext == ".docx":
            doc = Document(filepath)
            paragraphs = [p.text for p in doc.paragraphs]
            return "\n".join(paragraphs)
        elif ext == ".csv":
            # 用 pandas 讀取，將每個 cell 轉成字串並合併
            try:
                df = pd.read_csv(filepath, dtype=str, encoding='utf-8', engine='python', keep_default_na=False)
            except Exception:
                # 嘗試其他編碼
                df = pd.read_csv(filepath, dtype=str, encoding='latin1', engine='python', keep_default_na=False)
            # 將所有欄位的字串合併為一大段文字（以空格分隔）
            return " ".join(df.fillna("").astype(str).apply(lambda row: " ".join(row.values), axis=1).tolist())
        elif ext == ".json":
            with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                try:
                    obj = json.load(f)
                except Exception:
                    # 如果 JSON 是 line-delimited，每行一個 JSON
                    f.seek(0)
                    lines = f.readlines()
                    objs = []
                    for L in lines:
                        L = L.strip()
                        if not L: 
                            continue
                        try:
                            objs.append(json.loads(L))
                        except:
                            # 非 JSON 行 as-is
                            objs.append(L)
                    obj = objs
            # 將 JSON 物件遞迴轉成文字
            return json_to_text(obj)
        else:
            return ""
    except Exception as e:
        print(f"[錯誤] 無法讀取 {filepath} : {e}")
        return ""

def json_to_text(obj):
    if obj is None:
        return ""
    if isinstance(obj, dict):
        parts = []
        for k, v in obj.items():
            parts.append(str(k))
            parts.append(json_to_text(v))
        return " ".join(parts)
    if isinstance(obj, list):
        return " ".join(json_to_text(x) for x in obj)
    # 基本型別：轉字串
    return str(obj)

# 找到所有 substring 的 start index (allow overlapping)
def find_all_positions(text, sub, ignore_case=True):
    positions = []
    if not sub:
        return positions
    if ignore_case:
        text_lower = text.lower()
        sub_lower = sub.lower()
    else:
        text_lower = text
        sub_lower = sub
    start = 0
    while True:
        idx = text_lower.find(sub_lower, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + 1  # allow overlapping occurrences
    return positions

# 根據 rules 與單一檔案文字內容找出 snippts
def search_in_text(file_name, text, rules):
    text_norm = re.sub(r"\r\n|\r", "\n", text)  # normalize line endings
    text_norm = re.sub(r"\s+", " ", text_norm)  # collapse whitespace to single spaces
    results = []
    # for better token reporting we create jieba tokens but substring searches use raw text positions
    tokens = jieba.lcut(text_norm)

    for (A, B, C) in rules:
        if not A:
            continue
        # 搜尋所有 A、B 位置（忽略大小寫以利英文）；中文搜尋會不受影響
        posA = find_all_positions(text_norm, A, ignore_case=True)
        posB = find_all_positions(text_norm, B, ignore_case=True) if B else []
        # 若 B supplied: 找出任一 pair (a,b) 的字元距離 <= C
        if B:
            for a in posA:
                for b in posB:
                    # 計算字元距離 (以絕對起始位置差計，亦可改為 end-start)
                    dist = abs(a - b)
                    if dist <= C:
                        start = max(0, min(a, b) - 5)  # 包含少許 context (5 chars)
                        # end 使用 max of end positions; end position = index + len(keyword)
                        end = min(len(text_norm), max(a + len(A), b + len(B)) + 5)
                        snippet = text_norm[start:end]
                        results.append({
                            "file": file_name,
                            "A": A,
                            "B": B,
                            "C": C,
                            "match_type": "A&B",
                            "A_pos": a,
                            "B_pos": b,
                            "distance": dist,
                            "snippet": snippet
                        })
        else:
            # B empty: 以 A 為中心擷取前後 C 字元
            for a in posA:
                start = max(0, a - C)
                end = min(len(text_norm), a + len(A) + C)
                snippet = text_norm[start:end]
                results.append({
                    "file": file_name,
                    "A": A,
                    "B": "",
                    "C": C,
                    "match_type": "A_only",
                    "A_pos": a,
                    "B_pos": None,
                    "distance": None,
                    "snippet": snippet
                })
    return results

def process_folder(folder, rules):
    all_results = []
    for root, dirs, files in os.walk(folder):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in SUPPORTED_EXTS:
                continue
            fpath = os.path.join(root, fname)
            text = extract_text_from_file(fpath)
            if not text:
                continue
            hits = search_in_text(fname, text, rules)
            # 若沒有 hits 可以選擇保留或不保留 (此處僅加入有 hits 的)
            all_results.extend(hits)
    return all_results

def postprocess_and_save(results, out_csv, out_xlsx):
    if not results:
        print("沒有找到任何符合條件的結果。")
        return
    df = pd.DataFrame(results)
    # 使用 jieba 對 snippet 做斷詞並計算 token 數 (示範 use of jieba)
    df["snippet_tokens"] = df["snippet"].apply(lambda s: " ".join(jieba.lcut(s)))
    df["snippet_len_chars"] = df["snippet"].str.len().astype(int)

    # 使用 sklearn 的 CountVectorizer 計算簡單的 token counts（示範 sklearn 用法）
    vect = CountVectorizer(token_pattern=r"(?u)\b\w+\b")  # simple tokenization for alnum tokens
    try:
        X = vect.fit_transform(df["snippet"].astype(str))
        token_counts = np.asarray(X.sum(axis=1)).ravel()
        df["token_count_sklearn"] = token_counts
    except Exception:
        df["token_count_sklearn"] = np.nan

    # 儲存 CSV 與 Excel
    df.to_csv(out_csv, index=False, encoding="utf-8-sig")
    df.to_excel(out_xlsx, index=False)
    print(f"已輸出 {len(df)} 筆結果到 {out_csv} 與 {out_xlsx}")

def main():
    if not os.path.exists(TARGET_RULE_FILE):
        print(f"[錯誤] 找不到規則檔 {TARGET_RULE_FILE}。請建立 target-search.txt 並放在相同目錄。")
        return

    rules = load_rules(TARGET_RULE_FILE)
    if not rules:
        print("[錯誤] 沒有載入任何搜尋規則，請檢查 target-search.txt")
        return

    print(f"載入 {len(rules)} 條規則，開始掃描資料夾：{TARGET_FOLDER}")
    results = process_folder(TARGET_FOLDER, rules)
    postprocess_and_save(results, OUTPUT_CSV, OUTPUT_XLSX)

if __name__ == "__main__":
    main()
