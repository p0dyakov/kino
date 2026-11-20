import type { Metadata } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { GeistSerifRegular } from "geist/font/serif/regular";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const serifCyrillic = Source_Serif_4({
  subsets: ["cyrillic"],
  weight: "400",
  variable: "--font-serif-cyrillic",
});

export const metadata: Metadata = {
  title: "Kinostream",
  description: "Фильмы и сериалы в русской озвучке",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} ${GeistSerifRegular.variable} ${serifCyrillic.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
