import sys, os, io, json
# === 🔧 強制輸出為 UTF-8，避免 PHP 顯示亂碼 ===
sys.stdout.reconfigure(encoding='utf-8')

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans, DBSCAN
from sklearn.svm import SVC
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier, export_graphviz
from sklearn.ensemble import RandomForestClassifier
import graphviz

# === 中文字型設定（避免圖片中文字亂碼）===
import matplotlib
matplotlib.rcParams['font.sans-serif'] = ['Microsoft JhengHei']
matplotlib.rcParams['axes.unicode_minus'] = False

# === Graphviz PATH（依安裝位置調整）===
os.environ["PATH"] += os.pathsep + r"C:\Program Files\Graphviz\bin"

# === 檢查參數 ===
if len(sys.argv) < 3:
    print("使用方式: python analysis.py <input_path> <output_dir>")
    sys.exit(1)

input_path = sys.argv[1]
output_dir = sys.argv[2]
os.makedirs(output_dir, exist_ok=True)

# === 讀取資料 ===
try:
    filename = input_path.lower()
    if filename.endswith(".csv"):
        df = pd.read_csv(input_path)
    elif filename.endswith(".json"):
        df = pd.read_json(input_path)
    elif filename.endswith((".log", ".txt", ".jsonl")):
        with open(input_path, "r", encoding="utf-8") as f:
            content = f.read()
        try:
            lines = content.splitlines()
            records = [json.loads(line) for line in lines if line.strip()]
            df = pd.DataFrame(records)
        except:
            df = pd.DataFrame({"line": content.splitlines()})
    else:
        raise ValueError("不支援的檔案格式")

except Exception as e:
    print(f"讀取檔案錯誤：{e}")
    sys.exit(1)

# === 篩選數值欄位 ===
num_df = df.select_dtypes(include=np.number).dropna()
if num_df.shape[1] < 2:
    print("需要至少兩個數值欄位進行分析")
    sys.exit(1)

# === PCA 降維 ===
X = StandardScaler().fit_transform(num_df)
pca = PCA(n_components=2).fit_transform(X)

# === 標籤欄位偵測 ===
possible_targets = ["label", "class", "target", "category", "type", "分類", "種類", "標籤", "結果", "群組"]
target_candidates = [col for col in df.columns if any(key in col.lower() for key in possible_targets)]
y = LabelEncoder().fit_transform(df[target_candidates[0]]) if target_candidates else None

# === K-Means ===
try:
    kmeans = KMeans(n_clusters=3, random_state=42)
    labels_kmeans = kmeans.fit_predict(X)
    plt.figure(figsize=(6,5))
    plt.scatter(pca[:,0], pca[:,1], c=labels_kmeans, cmap="tab10", s=30)
    plt.title("K-means 聚類 (PCA 降維)")
    plt.xlabel("PC1"); plt.ylabel("PC2")
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, "kmeans.png"))
except Exception as e:
    print(f"K-Means 錯誤: {e}")

# === DBSCAN ===
try:
    dbscan = DBSCAN(eps=0.5, min_samples=5)
    labels_dbscan = dbscan.fit_predict(X)
    plt.figure(figsize=(6,5))
    plt.scatter(pca[:,0], pca[:,1], c=labels_dbscan, cmap="tab20", s=30)
    plt.title("DBSCAN 聚類 (PCA 降維)")
    plt.xlabel("PC1"); plt.ylabel("PC2")
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, "dbscan.png"))
except Exception as e:
    print(f"DBSCAN 錯誤: {e}")

# === SVM ===
try:
    if y is not None:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        svm = SVC(kernel='linear')
        svm.fit(X_train, y_train)
        plt.figure(figsize=(6,5))
        plt.scatter(pca[:,0], pca[:,1], c=y, cmap="coolwarm", s=30)
        plt.title("SVM 標籤分佈 (PCA)")
        plt.xlabel("PC1"); plt.ylabel("PC2")
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, "svm.png"))
except Exception as e:
    print(f"SVM 錯誤: {e}")

# === Decision Tree ===
try:
    if y is not None:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        dt = DecisionTreeClassifier(random_state=42)
        dt.fit(X_train, y_train)
        plt.figure(figsize=(6,5))
        plt.scatter(pca[:,0], pca[:,1], c=y, cmap="rainbow", s=30)
        plt.title("Decision Tree 標籤分佈 (PCA)")
        plt.xlabel("PC1"); plt.ylabel("PC2")
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, "decision_tree.png"))

        dot_data = export_graphviz(
            dt, out_file=None,
            feature_names=num_df.columns,
            class_names=[str(c) for c in np.unique(y)],
            filled=True, rounded=True, special_characters=True
        )
        graph = graphviz.Source(dot_data)
        graph.render(filename=os.path.join(output_dir, "decision_tree_graph"), format="png", cleanup=True)
except Exception as e:
    print(f"Decision Tree 錯誤: {e}")

# === Random Forest ===
try:
    if y is not None:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        rf = RandomForestClassifier(n_estimators=100, random_state=42)
        rf.fit(X_train, y_train)
        plt.figure(figsize=(6,5))
        plt.scatter(pca[:,0], pca[:,1], c=y, cmap="Spectral", s=30)
        plt.title("Random Forest 標籤分佈 (PCA)")
        plt.xlabel("PC1"); plt.ylabel("PC2")
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, "random_forest.png"))

        estimator = rf.estimators_[0]
        dot_data = export_graphviz(
            estimator, out_file=None,
            feature_names=num_df.columns,
            class_names=[str(c) for c in np.unique(y)],
            filled=True, rounded=True, special_characters=True
        )
        graph = graphviz.Source(dot_data)
        graph.render(filename=os.path.join(output_dir, "random_forest_graph"), format="png", cleanup=True)
except Exception as e:
    print(f"Random Forest 錯誤: {e}")

print("分析完成 ✅")
print(f"所有圖像儲存於: {output_dir}")
