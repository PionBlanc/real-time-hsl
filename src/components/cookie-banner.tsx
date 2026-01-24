import { useEffect, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { Button } from '@/components/ui/button'

const COOKIE_CONSENT_KEY = 'cookie-consent'

export function useCookieConsent() {
  const [consent, setConsent] = useState<'accepted' | 'declined' | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem(COOKIE_CONSENT_KEY)
    setConsent(stored as 'accepted' | 'declined' | null)
  }, [])

  const accept = () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, 'accepted')
    setConsent('accepted')
  }

  const decline = () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, 'declined')
    setConsent('declined')
  }

  return { consent, accept, decline }
}

export function CookieBanner() {
  const { consent, accept, decline } = useCookieConsent()

  if (consent !== null) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 z-[9999] mx-auto max-w-md rounded-lg border bg-background p-4 shadow-lg sm:left-4 sm:right-auto">
      <p className="mb-3 text-sm text-muted-foreground">
        We use cookies to analyze site usage and improve your experience.
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={decline}>
          Decline
        </Button>
        <Button size="sm" onClick={accept}>
          Accept
        </Button>
      </div>
    </div>
  )
}

export function ConditionalAnalytics() {
  const { consent } = useCookieConsent()

  if (consent !== 'accepted') return null

  return <Analytics />
}
