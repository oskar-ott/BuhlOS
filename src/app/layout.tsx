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
  description: "BuhlOS operating layer — admin (Command Centre) + field (Phil).",
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
