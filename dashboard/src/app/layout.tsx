import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/shell/app-shell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * No `title` here on purpose, and it must stay that way.
 *
 * A title in this object is a title Next OWNS: it renders it into the SSR head and re-commits
 * it on every client navigation and every late Suspense resolution. Since `metadata` is
 * Server Component only and every route in this app resolves its brand name from a browser
 * side fetch, the per route title has to be written from the client (see shell/document-title).
 * With a static title here, the two fight and Next wins whichever one lands last: measured,
 * that left "Add client" and "Overview / Demo" reverting to this string within milliseconds,
 * while a plain page load kept the right title. Owning the title in exactly one place is what
 * makes it deterministic. DocumentTitle sets a default on the routes that have no better one.
 */
export const metadata: Metadata = {
  description: "Internal GEO blog factory for Strategi client work.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
        {/* Pinned to light: this product ships one theme, and sonner would otherwise
            follow the operating system and render dark toasts on a light page. */}
        <Toaster theme="light" position="bottom-right" />
      </body>
    </html>
  );
}
