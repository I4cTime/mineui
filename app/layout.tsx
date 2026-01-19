import type { Metadata } from "next";
import { Geist, Geist_Mono, Press_Start_2P } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import Navbar from "@/app/components/Navbar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const pressStart = Press_Start_2P({
  variable: "--font-pixel",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MineUI",
  description: "Local Minecraft server control panel",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${pressStart.variable} antialiased`}
      >
        <Navbar />
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            className: "mc-toast",
            duration: 4000,
          }}
        />
      </body>
    </html>
  );
}
