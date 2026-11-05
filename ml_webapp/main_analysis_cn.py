# -*- coding: utf-8 -*-
"""
main_analysis_cn.py
中文論文／文件分析 + KMeans / DBSCAN / SVM / DecisionTree / RandomForest / PCA關鍵詞貢獻
獨立使用版本（不依賴 main_analysis.py）
"""

import sys, os, re, jieba, pdfplumber, numpy as np, pandas as pd, matplotlib.pyplot as plt
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans, DBSCAN
from sklearn.decomposition import PCA
from sklearn.metrics import classification_report, pairwise_distances
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier, export_graphviz
from sklearn.ensemble import RandomForestClassifier
import graphviz
import warnings

# === 防止亂碼 ===
sys.stdout.reconfigure(encoding='utf-8')
warnings.filterwarnings("ignore")

# === Matplotlib 中文字型設定 ===
import matplotlib
matplotlib.rcParams['font.sans-serif'] = ['Microsoft JhengHei']
matplotlib.rcParams['axes.unicode_minus'] = False

# === 基本參數 ===
UPLOAD_DIR = "./uploads"
OUTPUT_DIR = "./output_cn"  # ⬅️ 中文分析結果放在 output_cn 資料夾
STOPWORDS_FILE = "./uploads/stop_words.txt"
os.environ["PATH"] += os.pathsep + r"C:\Program Files\Graphviz\bin"

N_CLUSTERS = 3
DBSCAN_EPS = None
DBSCAN_MIN_SAMPLES = 2
TOP_N_KEYWORDS = 50

# === 準備輸出資料夾 ===
os.makedirs(OUTPUT_DIR, exist_ok=True)
for f in os.listdir(OUTPUT_DIR):
    try:
        os.remove(os.path.join(OUTPUT_DIR, f))
    except:
        pass

# === 讀取停用詞 ===
if os.path.exists(STOPWORDS_FILE):
    with open(STOPWORDS_FILE, "r", encoding="utf-8") as f:
        stop_words = [line.strip() for line in f if line.strip() and not line.startswith("#")]
else:
    stop_words = []
print(f"📄 已載入停用詞 {len(stop_words)} 個。")

# === 從 PDF 提取中文文字 ===
def extract_text_from_pdf(pdf_path):
    text = ""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text += (page.extract_text() or "") + "\n"
    except Exception as e:
        print(f"⚠️ PDF 讀取錯誤：{pdf_path} ({e})")
        return ""
    text = re.split(r"(參考文獻|References|Bibliography|致謝|Acknowledgements?)", text, flags=re.I)[0]
    return text

# === 中文清理與斷詞 ===
def clean_and_tokenize(text):
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'[0-9a-zA-Z]', ' ', text)        # 移除英數字
    text = re.sub(r'[^\u4e00-\u9fff]', ' ', text)   # 僅保留中文
    text = text.strip()
    tokens = jieba.lcut(text)
    filtered = [w for w in tokens if w not in stop_words and len(w) > 1]
    return " ".join(filtered)

# === TF-IDF 抽取關鍵詞 ===
def extract_top_keywords(corpus, top_n=TOP_N_KEYWORDS):
    vectorizer = TfidfVectorizer(max_features=5000, token_pattern=r'(?u)\b[\u4e00-\u9fff]{2,}\b')
    X = vectorizer.fit_transform(corpus)
    feature_names = vectorizer.get_feature_names_out()
    scores = np.asarray(X.sum(axis=0)).ravel()
    top_idx = np.argsort(scores)[::-1][:top_n]
    return [feature_names[i] for i in top_idx], X.toarray(), vectorizer

# === 主分析流程 ===
def main():
    pdf_files = [os.path.join(UPLOAD_DIR, f) for f in os.listdir(UPLOAD_DIR) if f.lower().endswith(".pdf")]
    if not pdf_files:
        print("❌ 找不到 PDF 檔案，請上傳中文論文！")
        return

    print(f"📘 找到 {len(pdf_files)} 份 PDF，開始中文關鍵詞分析...\n")

    # 1️⃣ 文字擷取與切詞
    texts = [extract_text_from_pdf(p) for p in pdf_files]
    corpus = [clean_and_tokenize(t) for t in texts]

    # 2️⃣ TF-IDF
    top_keywords, tfidf_dense, vectorizer = extract_top_keywords(corpus)
    print(f"📑 前 {len(top_keywords)} 個關鍵詞：{', '.join(top_keywords[:10])}\n")

    # 3️⃣ PCA
    pca = PCA(n_components=2, random_state=42)
    X_pca = pca.fit_transform(tfidf_dense)
    jitter = np.random.normal(0, 0.01, X_pca.shape)

    # 4️⃣ KMeans 聚類
    n_clusters = max(2, min(N_CLUSTERS, len(pdf_files)))
    km = KMeans(n_clusters=n_clusters, random_state=42, n_init="auto")
    km_labels = km.fit_predict(tfidf_dense)

    # 5️⃣ DBSCAN 聚類
    if DBSCAN_EPS is None:
        D = pairwise_distances(X_pca)
        k = max(1, DBSCAN_MIN_SAMPLES - 1)
        kth = np.sort(D, axis=1)[:, k]
        eps = max(0.1, round(float(np.median(kth)), 2))
    else:
        eps = float(DBSCAN_EPS)
    db = DBSCAN(eps=eps, min_samples=DBSCAN_MIN_SAMPLES)
    db_labels = db.fit_predict(tfidf_dense)

    # 6️⃣ SVM + 樹模型
    y = km_labels.copy()
    if len(np.unique(y)) > 1:
        clf = SVC(kernel="linear", random_state=42)
        clf.fit(tfidf_dense, y)
        y_pred = clf.predict(tfidf_dense)
        print("📊 SVM 分類結果：")
        print(classification_report(y, y_pred, digits=2, zero_division=0))

        # Decision Tree
        dt = DecisionTreeClassifier(random_state=42)
        dt.fit(tfidf_dense, y)
        plt.figure(figsize=(6,5))
        plt.scatter(X_pca[:,0], X_pca[:,1], c=y, cmap="rainbow", s=80)
        plt.title("決策樹 (Decision Tree) 分佈")
        plt.tight_layout()
        plt.savefig(os.path.join(OUTPUT_DIR, "decision_tree.png"))
        plt.close()

        dot_data = export_graphviz(dt, out_file=None,
            feature_names=vectorizer.get_feature_names_out(),
            class_names=[str(c) for c in np.unique(y)],
            filled=True, rounded=True, special_characters=True)
        graphviz.Source(dot_data).render(filename=os.path.join(OUTPUT_DIR, "decision_tree_graph"), format="png", cleanup=True)

        # Random Forest
        rf = RandomForestClassifier(n_estimators=100, random_state=42)
        rf.fit(tfidf_dense, y)
        plt.figure(figsize=(6,5))
        plt.scatter(X_pca[:,0], X_pca[:,1], c=y, cmap="Spectral", s=80)
        plt.title("隨機森林 (Random Forest) 分佈")
        plt.tight_layout()
        plt.savefig(os.path.join(OUTPUT_DIR, "random_forest.png"))
        plt.close()

        estimator = rf.estimators_[0]
        dot_data = export_graphviz(estimator, out_file=None,
            feature_names=vectorizer.get_feature_names_out(),
            class_names=[str(c) for c in np.unique(y)],
            filled=True, rounded=True, special_characters=True)
        graphviz.Source(dot_data).render(filename=os.path.join(OUTPUT_DIR, "random_forest_graph"), format="png", cleanup=True)

    # 7️⃣ 三圖合併
    plt.figure(figsize=(6, 15))
    plt.subplot(3,1,1); plt.scatter(X_pca[:,0]+jitter[:,0], X_pca[:,1]+jitter[:,1], c=km_labels, s=80, cmap="tab10"); plt.title("KMeans 聚類結果")
    plt.subplot(3,1,2); plt.scatter(X_pca[:,0]+jitter[:,0], X_pca[:,1]+jitter[:,1], c=db_labels, s=80, cmap="tab10"); plt.title(f"DBSCAN 聚類結果 (eps={eps})")
    plt.subplot(3,1,3); plt.scatter(X_pca[:,0]+jitter[:,0], X_pca[:,1]+jitter[:,1], c=y, s=80, cmap="tab10"); plt.title("SVM 分類結果 (依據 KMeans 標籤)")
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, "cluster_combined.png"), dpi=150)
    plt.close()

    # 8️⃣ PCA 關鍵詞貢獻與群組代表詞
    feature_names = vectorizer.get_feature_names_out()
    pca_loadings = pd.DataFrame(pca.components_.T, columns=['PCA1', 'PCA2'], index=feature_names)
    summary_lines = ["=== 關鍵詞在 PCA1 與 PCA2 的貢獻值 ===\n"]
    for word, row in pca_loadings.iterrows():
        if row['PCA1'] != 0 or row['PCA2'] != 0:
            summary_lines.append(f"{word:<10} -> PCA1: {row['PCA1']:+.4f}, PCA2: {row['PCA2']:+.4f}")

    summary_lines.append("\n\n=== 各群組代表關鍵詞 ===")
    cluster_centers = km.cluster_centers_
    for i, center in enumerate(cluster_centers):
        top_idx = np.argsort(center)[::-1][:5]
        top_words = [feature_names[j] for j in top_idx]
        summary_lines.append(f"\n群組 {i+1} -> " + "、".join(top_words))

    summary_text = "\n".join(summary_lines)
    print(summary_text)
    with open(os.path.join(OUTPUT_DIR, "pca_keywords_summary.txt"), "w", encoding="utf-8") as f:
        f.write(summary_text)

    print("\n✅ 中文分析完成，結果已輸出至 /output_cn/")

if __name__ == "__main__":
    main()
