import './globals.css'
import Script from 'next/script'

export const metadata = { title: 'MoonVape' }
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, viewportFit: 'cover' as const }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  )
}
