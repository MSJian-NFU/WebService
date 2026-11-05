import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BourbonAI Modular Lab",
  description: "模組化生醫影像處理、資料分析與 SOM 影像檢索系統。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

const assetFailureGuard = `
(() => {
  const verify = () => {
    const stylesheetLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const cssReady = stylesheetLinks.length > 0 && stylesheetLinks.some((link) => Boolean(link.sheet));
    const appReady = document.documentElement.dataset.bourbonaiHydrated === "true";
    if (cssReady && appReady) return;
    if (document.getElementById("bourbonai-asset-error")) return;
    const notice = document.createElement("div");
    notice.id = "bourbonai-asset-error";
    notice.setAttribute("role", "alert");
    notice.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "left:16px",
      "right:16px",
      "top:16px",
      "padding:14px 18px",
      "border:2px solid #ff6b6b",
      "border-radius:10px",
      "background:#2a1015",
      "color:#fff",
      "font:600 15px/1.55 system-ui,sans-serif",
      "box-shadow:0 10px 35px rgba(0,0,0,.45)"
    ].join(";");
    notice.textContent = "BourbonAI 的 CSS 或 JavaScript 未載入。請在專案目錄執行 npm run build:xampp，再以 npm run start:xampp 啟動；不要使用舊版 npx vinext start。";
    document.body.appendChild(notice);
  };
  window.addEventListener("load", () => window.setTimeout(verify, 1800), { once: true });
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <head>
        <script dangerouslySetInnerHTML={{ __html: assetFailureGuard }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
