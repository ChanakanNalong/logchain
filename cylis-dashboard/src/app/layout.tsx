import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Providers from "./providers";

// ฟอนต์อยู่ใน repo (src/app/fonts · OFL-1.1 · มาจาก @fontsource-variable 5.3.0 ชุด latin)
// เดิมใช้ next/font/google ซึ่งดึงจาก Google Fonts ทุกครั้งที่ build — เน็ตสะดุด = CI แดง
// และ bootstrap.sh บนเครื่องไม่มีเน็ต build dashboard ไม่ผ่าน (worklog 2026-09-23 หัวข้อ 38)
// ไฟล์เป็น variable font: ไฟล์เดียวครอบทุก weight
const manrope = localFont({
  src: "./fonts/manrope-latin-wght-normal.woff2",
  variable: "--font-sans",
  weight: "200 800",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-mono",
  weight: "100 800",
});

export const metadata: Metadata = {
  title: "Cylis — LogChain Security Dashboard",
  description: "Log integrity, ML anomaly detection and Merkle proof verification for LogChain.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrainsMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
