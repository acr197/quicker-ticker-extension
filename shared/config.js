// shared/config.js — Static configuration: affiliate URLs and constants.
// All URLs MUST be https://. The runtime validates this before opening any link.

(function (root) {
  'use strict';

  // Update these as offers change. The UI never hardcodes dollar amounts.
  // Each entry: { id, name, domain, blurb, url, accent }
  // `domain` is the bare host used to load the site favicon as the logo.
  const BROKERAGE_OFFERS = [
    {
      id: 'robinhood',
      name: 'Robinhood',
      domain: 'robinhood.com',
      blurb: 'Sign up and fund any amount — you get 1 free fractional share (most users receive a share worth $5–$200).',
      url: 'https://robinhood.com/',
      accent: '#21ce99'
    },
    {
      id: 'webull',
      name: 'Webull',
      domain: 'webull.com',
      blurb: 'Open an account and deposit $100+ to receive up to 12 free fractional shares (value varies by promo).',
      url: 'https://www.webull.com/',
      accent: '#2c7be5'
    },
    {
      id: 'ibkr',
      name: 'Interactive Brokers',
      domain: 'interactivebrokers.com',
      blurb: 'Refer a friend: you earn up to $1,000 in IBKR stock and they get a free IBKR share after funding.',
      url: 'https://www.interactivebrokers.com/',
      accent: '#d9241c'
    },
    {
      id: 'public',
      name: 'Public',
      domain: 'public.com',
      blurb: 'Both of you get a free slice of stock (typically $3–$70 in value) after your friend makes their first deposit.',
      url: 'https://public.com/',
      accent: '#7e3ff2'
    },
    {
      id: 'etoro',
      name: 'eToro',
      domain: 'etoro.com',
      blurb: 'New users get a cash reward (usually $10–$50) after making a qualifying deposit. Region-dependent.',
      url: 'https://www.etoro.com/',
      accent: '#13c2c2'
    }
  ];

  const RESEARCH_OFFERS = [
    {
      id: 'tradingview',
      name: 'TradingView',
      domain: 'tradingview.com',
      blurb: 'Upgrade to any paid plan and both of you earn $15 in account credit toward your next renewal.',
      url: 'https://www.tradingview.com/',
      accent: '#2962ff'
    },
    {
      id: 'seekingalpha',
      name: 'Seeking Alpha',
      domain: 'seekingalpha.com',
      blurb: 'Your friend gets a 14-day free trial of Premium. If they subscribe, you get $25 in credits.',
      url: 'https://seekingalpha.com/',
      accent: '#ff6f3c'
    }
  ];

  const CRYPTO_OFFERS = [
    {
      id: 'coinbase',
      name: 'Coinbase',
      domain: 'coinbase.com',
      blurb: 'Both of you get $10 in Bitcoin after your friend buys or sells $100+ in crypto within 180 days.',
      url: 'https://www.coinbase.com/',
      accent: '#0052ff'
    },
    {
      id: 'kraken',
      name: 'Kraken',
      domain: 'kraken.com',
      blurb: 'Both earn $20 in BTC after your friend trades $100+ in the first 30 days.',
      url: 'https://www.kraken.com/',
      accent: '#5741d9'
    },
    {
      id: 'gemini',
      name: 'Gemini',
      domain: 'gemini.com',
      blurb: 'Both get $15 in Bitcoin after your friend buys or sells $100+ in crypto within 30 days.',
      url: 'https://www.gemini.com/',
      accent: '#00dcfa'
    },
    {
      id: 'binanceus',
      name: 'Binance.US',
      domain: 'binance.us',
      blurb: 'Earn 40% of your friend\u2019s trading fees for life as a commission payout in crypto.',
      url: 'https://www.binance.us/',
      accent: '#f0b90b'
    },
    {
      id: 'cryptocom',
      name: 'Crypto.com',
      domain: 'crypto.com',
      blurb: 'Both receive $25 in CRO after your friend signs up, verifies, and stakes CRO for their Visa card.',
      url: 'https://crypto.com/',
      accent: '#0a3a82'
    }
  ];

  function isHttps(url) {
    return typeof url === 'string' && url.startsWith('https://');
  }

  function safeOpen(url) {
    if (!isHttps(url)) return;
    chrome.tabs.create({ url });
  }

  // Defensive: filter out any non-https entries (shouldn't happen).
  const allOffers = [].concat(BROKERAGE_OFFERS, RESEARCH_OFFERS, CRYPTO_OFFERS);
  for (const o of allOffers) {
    if (!isHttps(o.url)) {
      // eslint-disable-next-line no-console
      console.warn('[QuickerTicker] dropping non-https offer', o.id);
    }
  }

  root.QTConfig = {
    BROKERAGE_OFFERS: BROKERAGE_OFFERS.filter((o) => isHttps(o.url)),
    RESEARCH_OFFERS:  RESEARCH_OFFERS.filter((o) => isHttps(o.url)),
    CRYPTO_OFFERS:    CRYPTO_OFFERS.filter((o) => isHttps(o.url)),
    isHttps,
    safeOpen,
    DISCLOSURE: 'Some links below are referral links. I may earn a commission at no cost to you. All bonuses listed are real offers for you.',
    // One universal terms line used at the bottom of the panel instead of
    // repeating it per-card. Any reward amount above is our best estimate —
    // each platform sets the final value, eligibility, and expiration.
    UNIVERSAL_TERMS: 'All rewards above are estimates. Actual amounts, eligibility, and expiration dates are set by each platform and can change without notice. See the current terms on each site before signing up.'
  };
})(typeof window !== 'undefined' ? window : globalThis);
