import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/shell/app-shell";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

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
  description: "Strategi Canon, the internal GEO content engine for Strategi client work.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning because the inline script below stamps `.dark` onto <html>
    // before React hydrates, and React must accept the DOM's class rather than flag it.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Applies the stored theme preference BEFORE first paint, so a dark-preferring
            operator never sees a light flash. The script is a constant owned by
            src/lib/theme.ts; system mode follows prefers-color-scheme, and the live media
            listener lives in the theme store. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
        {/* Follows the operator's theme toggle through the theme store inside sonner.tsx,
            so toasts never render light chrome on a dark page or the reverse. */}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
