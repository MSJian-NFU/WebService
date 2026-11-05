# -*- coding: utf-8 -*-
"""
main_analysis_all.py
多格式自動偵測版：整合關鍵字分析 + KMeans / DBSCAN / SVM / Tree / Forest + PCA
支援 .pdf / .txt / .log / .csv / .json
相容 Windows + XAMPP + PHP 既有流程與輸出檔名
"""

import sys, os, re, json, warnings
import numpy as np
import pandas as pd
import jieba
import pdfplumber
import matplotlib.pyplot as plt

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans, DBSCAN
from sklearn.decomposition import PCA
from sklearn.metrics import classification_report, pairwise_distances
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier, export_graphviz
from sklearn.ensemble import RandomForestClassifier

import graphviz

# ====== 基本輸出編碼與警告 ======
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass
warnings.filterwarnings("ignore")

# ====== Matplotlib 中文設定（避免亂碼） ======
import matplotlib
matplotlib.rcParams['font.sans-serif'] = ['Microsoft JhengHei']   # 微軟正黑體
matplotlib.rcParams['axes.unicode_minus'] = False

# ====== 路徑與參數 ======
UPLOAD_DIR = "./uploads"
OUTPUT_DIR = "./output"
STOPWORDS_FILE = "./uploads/stop_words.txt"   # 可留空不存在
os.environ["PATH"] += os.pathsep + r"C:\Program Files\Graphviz\bin"

N_CLUSTERS = 3
DBSCAN_EPS = None
DBSCAN_MIN_SAMPLES = 2
TOP_N_KEYWORDS = 50
MAX_FEATURES = 5000

# ====== 初始化輸出資料夾：安全清空舊檔 ======
os.makedirs(OUTPUT_DIR, exist_ok=True)
for f in os.listdir(OUTPUT_DIR):
    try:
        os.remove(os.path.join(OUTPUT_DIR, f))
    except:
        pass

# ====== 載入停用詞（可選） ======
if os.path.exists(STOPWORDS_FILE):
    with open(STOPWORDS_FILE, "r", encoding="utf-8", errors="ignore") as f:
        custom_stopwords = [line.strip().lower() for line in f if line.strip() and not line.startswith("#")]
else:
    custom_stopwords = []

# ====== 各格式讀取工具 ======
def extract_text_from_pdf(pdf_path: str) -> str:
    """
    讀 PDF：
    1) 抽出全文
    2) 優先截取 abstract/summary/keywords 到 introduction 之前的區段
    3) 去掉 references / bibliography 後段
    """
    text = ""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text += (page.extract_text() or "") + "\n"
    except Exception as e:
        print(f"PDF 讀取錯誤：{pdf_path}, {e}")

    # 去掉參考文獻等尾段
    text = re.split(r"(references|bibliography|acknowledgements?|supplementary)", text, flags=re.I)[0]

    # 優先抓摘要/關鍵字到導論
    m = re.search(
        r"(abstract|summary|keywords)[\s:]*?(.*?)(introduction|background|materials and methods)",
        text, flags=re.I | re.S
    )
    if m:
        text = m.group(0)
    return text

def extract_text_from_txt(file_path: str) -> str:
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception as e:
        print(f"TXT/LOG 讀取錯誤：{file_path}, {e}")
        return ""

def extract_text_from_csv(file_path: str) -> str:
    """
    將整張表轉為文字塊（欄名 + 內容）。
    若資料多為數字也能被 TF-IDF 視為 token；後續會過濾純數字 token。
    """
    try:
        df = pd.read_csv(file_path, dtype=str, encoding="utf-8", engine="python")
    except Exception:
        # 退而求其次
        df = pd.read_csv(file_path, dtype=str, encoding_errors="ignore", engine="python")
    df = df.fillna("")
    return df.to_string(index=False)

def _flatten_json(obj):
    """遞迴攤平 JSON 為字串清單"""
    parts = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            parts.append(str(k))
            parts.extend(_flatten_json(v))
    elif isinstance(obj, list):
        for v in obj:
            parts.extend(_flatten_json(v))
    else:
        parts.append(str(obj))
    return parts

def extract_text_from_json(file_path: str) -> str:
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            data = json.load(f)
        return " ".join(_flatten_json(data))
    except Exception as e:
        print(f"JSON 讀取錯誤：{file_path}, {e}")
        return ""

def read_text_any(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".pdf":
        return extract_text_from_pdf(file_path)
    elif ext in [".txt", ".log"]:
        return extract_text_from_txt(file_path)
    elif ext == ".csv":
        return extract_text_from_csv(file_path)
    elif ext == ".json":
        return extract_text_from_json(file_path)
    else:
        # 不支援的格式：略過
        print(f"⚠️ 略過不支援的檔案格式：{os.path.basename(file_path)}")
        return ""

# ====== 清理與分詞 ======
def clean_and_tokenize(text: str) -> str:
    # 1) 移除網址、DOI 等
    text = re.sub(r'https?://\S+', ' ', text)
    text = re.sub(r'\bdoi:\s*\S+', ' ', text)

    # 2) 僅保留 中/英/數字/常見分隔符（含 + / - _ 等）
    text = re.sub(r'[^a-zA-Z0-9\u4e00-\u9fff_\-\/\+\sκ]', ' ', text)

    # 3) 小寫化
    text = text.lower()

    # 4) jieba 切詞（可處理中英混雜；英文會以原詞為主）
    tokens = jieba.lcut(text)

    # 5) 過濾：停用詞 / 單字 / 純數字
    kept = []
    for w in tokens:
        if w in custom_stopwords:
            continue
        if len(w) < 2:
            continue
        if re.fullmatch(r'\d+', w):
            continue
        kept.append(w)

    return " ".join(kept)

# ====== 關鍵字抽取（全語料 Top-N） ======
def extract_top_keywords(corpus, top_n=TOP_N_KEYWORDS):
    """
    先把所有文件合併，再用 TF-IDF 找最重要的 top_n 關鍵詞。
    若語料過於稀疏導致空詞彙，會自動退回無 vocabulary 的 TF-IDF 再挑 top_n。
    """
    all_text = " ".join(corpus)
    if not all_text.strip():
        return []

    def _rank_terms(vectorizer):
        X = vectorizer.fit_transform([all_text])
        feature_names = vectorizer.get_feature_names_out()
        scores = X.toarray()[0]
        order = np.argsort(scores)[::-1]
        top_idx = order[:min(top_n, len(feature_names))]
        return [feature_names[i] for i in top_idx]

    try:
        # 使用 token_pattern 與停用詞，偏向專有名詞/複合詞
        vec = TfidfVectorizer(
            max_features=MAX_FEATURES,
            ngram_range=(1, 2),
            token_pattern=r'(?u)\b[\w\-/\+]{3,}\b',
            stop_words=custom_stopwords
        )
        top = _rank_terms(vec)
        if top: return top
    except Exception:
        pass

    # 後備：不指定 token_pattern / 停用詞，盡量撈到詞
    vec2 = TfidfVectorizer(max_features=MAX_FEATURES, ngram_range=(1, 2))
    try:
        top = _rank_terms(vec2)
        return top
    except Exception:
        return []

# ====== 主流程 ======
def main():
    # 收集可支援的檔案
    supported_exts = {".pdf", ".txt", ".log", ".csv", ".json"}
    files = [
        os.path.join(UPLOAD_DIR, f) for f in os.listdir(UPLOAD_DIR)
        if os.path.splitext(f)[1].lower() in supported_exts
    ]

    if not files:
        print("找不到可支援的檔案（支援 .pdf / .txt / .log / .csv / .json）")
        return

    print(f"找到 {len(files)} 個檔案，開始分析...")

    # 逐檔讀取文字
    raw_texts = []
    for p in files:
        t = read_text_any(p)
        raw_texts.append(t)

    # 預處理 + 分詞
    corpus = [clean_and_tokenize(t) for t in raw_texts]

    # 檢查是否完全空白
    if all((not c.strip()) for c in corpus):
        print("❌ 文字內容經過清理後為空，無法進行 TF-IDF 分析。請確認檔案內容或移除純數值表格。")
        return

    # 取全語料 Top-N 關鍵詞
    top_keywords = extract_top_keywords(corpus, TOP_N_KEYWORDS)
    if not top_keywords:
        print("⚠️ 無法穩定抽取關鍵詞，改以全文詞彙建模。")
        vectorizer = TfidfVectorizer(max_features=MAX_FEATURES, ngram_range=(1, 2), lowercase=True)
    else:
        print(f"前 {len(top_keywords)} 個關鍵字（示意 10）：{', '.join(top_keywords[:10])}...")
        vectorizer = TfidfVectorizer(vocabulary=top_keywords, ngram_range=(1, 2), lowercase=True)

    # 向量化
    X = vectorizer.fit_transform(corpus)
    tfidf_dense = X.toarray()

    # 若全零（極少見），直接退出
    if not np.any(tfidf_dense):
        print("❌ TF-IDF 為全零矩陣，可能是內容皆為數字/符號或清理過度。請更換檔案或調整清理規則。")
        return

    # PCA 降維
    pca = PCA(n_components=2, random_state=42)
    X_pca = pca.fit_transform(tfidf_dense)
    jitter = np.random.normal(0, 0.01, X_pca.shape)

    # KMeans 聚類（至少 2 群，最多文件數）
    n_clusters = max(2, min(N_CLUSTERS, len(files)))
    km = KMeans(n_clusters=n_clusters, random_state=42, n_init="auto")
    km_labels = km.fit_predict(tfidf_dense)

    # DBSCAN 自動估 eps（取 PCA 空間的中位 K 距離）
    if DBSCAN_EPS is None:
        D = pairwise_distances(X_pca)
        k = max(1, DBSCAN_MIN_SAMPLES - 1)
        kth = np.sort(D, axis=1)[:, k]
        eps = max(0.1, round(float(np.median(kth)), 2))
    else:
        eps = float(DBSCAN_EPS)
    db = DBSCAN(eps=eps, min_samples=DBSCAN_MIN_SAMPLES)
    db_labels = db.fit_predict(tfidf_dense)

    # 以 KMeans 當 pseudo-label 做分類與樹模型
    y = km_labels.copy()
    if len(np.unique(y)) > 1:
        clf = SVC(kernel="linear", random_state=42)
        clf.fit(tfidf_dense, y)
        y_pred = clf.predict(tfidf_dense)
        print(classification_report(y, y_pred, digits=2, zero_division=0))

        # Decision Tree
        dt = DecisionTreeClassifier(random_state=42)
        dt.fit(tfidf_dense, y)
        plt.figure(figsize=(6,5))
        plt.scatter(X_pca[:,0], X_pca[:,1], c=y, cmap="rainbow", s=80)
        plt.title("Decision Tree 標籤分佈 (PCA)")
        plt.tight_layout()
        plt.savefig(os.path.join(OUTPUT_DIR, "decision_tree.png"))
        plt.close()
        try:
            dot_data = export_graphviz(
                dt, out_file=None,
                feature_names=vectorizer.get_feature_names_out(),
                class_names=[str(c) for c in np.unique(y)],
                filled=True, rounded=True, special_characters=True
            )
            graphviz.Source(dot_data).render(
                filename=os.path.join(OUTPUT_DIR, "decision_tree_graph"),
                format="png", cleanup=True
            )
        except Exception as e:
            print(f"⚠️ Decision Tree 視覺化失敗：{e}（請確認已安裝 Graphviz 並加入 PATH）")

        # Random Forest
        rf = RandomForestClassifier(n_estimators=100, random_state=42)
        rf.fit(tfidf_dense, y)
        plt.figure(figsize=(6,5))
        plt.scatter(X_pca[:,0], X_pca[:,1], c=y, cmap="Spectral", s=80)
        plt.title("Random Forest 標籤分佈 (PCA)")
        plt.tight_layout()
        plt.savefig(os.path.join(OUTPUT_DIR, "random_forest.png"))
        plt.close()
        try:
            estimator = rf.estimators_[0]
            dot_data = export_graphviz(
                estimator, out_file=None,
                feature_names=vectorizer.get_feature_names_out(),
                class_names=[str(c) for c in np.unique(y)],
                filled=True, rounded=True, special_characters=True
            )
            graphviz.Source(dot_data).render(
                filename=os.path.join(OUTPUT_DIR, "random_forest_graph"),
                format="png", cleanup=True
            )
        except Exception as e:
            print(f"⚠️ Random Forest 視覺化失敗：{e}（請確認已安裝 Graphviz 並加入 PATH）")

    # 三圖合併：KMeans / DBSCAN / SVM(pseudo-label)
    plt.figure(figsize=(6, 15))
    plt.subplot(3,1,1); plt.scatter(X_pca[:,0]+jitter[:,0], X_pca[:,1]+jitter[:,1], c=km_labels, s=80, cmap="tab10"); plt.title("K-Means Clustering")
    plt.subplot(3,1,2); plt.scatter(X_pca[:,0]+jitter[:,0], X_pca[:,1]+jitter[:,1], c=db_labels, s=80, cmap="tab10"); plt.title(f"DBSCAN (eps={eps})")
    plt.subplot(3,1,3); plt.scatter(X_pca[:,0]+jitter[:,0], X_pca[:,1]+jitter[:,1], c=y, s=80, cmap="tab10"); plt.title("SVM (pseudo-label=KMeans)")
    plt.tight_layout(); plt.savefig(os.path.join(OUTPUT_DIR, "cluster_combined.png"), dpi=150); plt.close()

    # PCA 關鍵字貢獻 + 各群代表詞
    feature_names = vectorizer.get_feature_names_out()
    pca_loadings = pd.DataFrame(pca.components_.T, columns=['PCA1', 'PCA2'], index=feature_names)

    summary_lines = ["=== 關鍵字在 PCA1 & PCA2 中的貢獻權重 (已過濾零值) ===\n"]
    nonzero = 0
    for word, row in pca_loadings.iterrows():
        if row['PCA1'] != 0 or row['PCA2'] != 0:
            summary_lines.append(f"{word:<25} -> PCA1: {row['PCA1']:+.4f}, PCA2: {row['PCA2']:+.4f}")
            nonzero += 1
    if nonzero == 0:
        summary_lines.append("(所有載荷為 0，可能為極度稀疏語料或維度過低)")

    summary_lines.append("\n\n=== 各群組代表關鍵詞 ===")
    try:
        cluster_centers = km.cluster_centers_
        for i, center in enumerate(cluster_centers):
            top_idx = np.argsort(center)[::-1][:3]
            top_words = [feature_names[j] for j in top_idx]
            summary_lines.append(f"Cluster {i} -> " + ", ".join(top_words))
    except Exception as e:
        summary_lines.append(f"(無法產生代表詞：{e})")

    summary_text = "\n".join(summary_lines)
    print(summary_text)
    with open(os.path.join(OUTPUT_DIR, "pca_keywords_summary.txt"), "w", encoding="utf-8") as f:
        f.write(summary_text)

    print("\n分析完成 ✅ 已輸出所有結果")

if __name__ == "__main__":
    main()
