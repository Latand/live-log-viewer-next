import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Log Viewer",
  description: "Agent Log Viewer for Codex and Claude agent logs",
};

/* The on-screen keyboard shrinks the layout instead of covering it, so the
   composer of the focused pane stays visible while typing on a phone. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-dvh overflow-hidden font-sans text-[15px]">
        {children}
      </body>
    </html>
  );
}
