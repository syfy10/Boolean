import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StockEdge - Find Your Edge",
  description: "Market scanning platform with breadth indicators, leadership analysis, and swing setups",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}