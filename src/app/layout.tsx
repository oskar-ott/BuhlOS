import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import type { ReactNode } from "react";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

export const metadata: Metadata = {
  title: "BuhlOS",
  description: "BuhlOS operating layer — office admin + field app.",
  // 2026-07-26 owner-supplied app icon (navy tile, yellow plug pins). Same
  // /icon* URLs the manifest has always referenced; the 180px apple-touch-icon
  // is what iOS uses for the home-screen install.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192" }],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable}`}>
      <body className="font-sans">
        <DemoModeBanner />
        {children}
      </body>
    </html>
  );
}
