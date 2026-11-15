import type { Metadata, Viewport } from 'next';
import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';

// Pairing: Fraunces (a soft, slightly old-style serif) for headings and numerals,
// IBM Plex Sans for reading text, IBM Plex Mono for handles, domains and data.
const display = Fraunces({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'handle-scout - is your name free everywhere?',
  description:
    'Enter one name and see which domains and usernames are available, which are taken, and which alternatives are free everywhere. Honest about what cannot be checked.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f0e6' },
    { media: '(prefers-color-scheme: dark)', color: '#161513' },
  ],
};

// Apply a saved theme before first paint so the page does not flash.
const themeScript = `try{var t=localStorage.getItem('hs-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
