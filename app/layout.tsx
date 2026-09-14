import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lawcus QA Agent",
  description: "A local workspace for repeatable login testing and evidence.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
