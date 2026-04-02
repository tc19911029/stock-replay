import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { RiskDisclaimerModal, FeatureGuideModal } from "@/components/RiskDisclaimer";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ColorThemeInit } from "@/components/ColorThemeInit";
import { Toaster } from "sonner";
import RegisterPWA from "@/components/RegisterPWA";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "K線走圖練習器 — 台股陸股掃描選股與策略回測",
    template: "%s | K線走圖練習器",
  },
  description: "免費股票分析工具：K線歷史回放練習、六大條件批量掃描、策略回測驗證、飆股潛力評分。支援台股與陸股，幫助投資人更有效率地看盤、驗證策略、輔助決策。",
  keywords: ["台股", "陸股", "技術分析", "K線", "掃描選股", "策略回測", "飆股", "六大條件", "當沖", "股票"],
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "K線練習",
  },
  openGraph: {
    title: "K線走圖練習器 — 台股陸股掃描選股與策略回測",
    description: "免費股票分析工具：K線歷史回放、六大條件掃描、策略回測、飆股評分",
    type: "website",
    locale: "zh_TW",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-TW"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <meta name="theme-color" content="#0f172a" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          <TooltipProvider>
            <ColorThemeInit />
            <RiskDisclaimerModal />
            <FeatureGuideModal />
            <Toaster position="top-right" richColors closeButton theme="dark" />
            {children}
            <RegisterPWA />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
