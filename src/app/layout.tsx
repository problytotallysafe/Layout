import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Layout — Tile planning by Buildr",
  description: "Draw a room, test tile layouts, and find a better starting point before installation.",
  icons: { icon: "/app-icon-512.png", apple: "/app-icon-512.png" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

