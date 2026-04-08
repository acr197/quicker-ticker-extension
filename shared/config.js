// shared/config.js — Static configuration: affiliate URLs and constants.
// All URLs MUST be https://. The runtime validates this before opening any link.

(function (root) {
  'use strict';

  // Update these as offers change. The UI never hardcodes dollar amounts.
  // Each entry: { id, name, blurb, url, accent }
  const BROKERAGE_OFFERS = [
    {
      id: 'robinhood',
      name: 'Robinhood',
      blurb: 'Get a free stock when you open and fund an account.',
      url: 'https://robinhood.com/',
      accent: '#21ce99'
    },
    {
      id: 'webull',
      name: 'Webull',
      blurb: 'Get free stocks for signing up and depositing.',
      url: 'https://www.webull.com/',
      accent: '#2c7be5'
    },
    {
      id: 'ibkr',
      name: 'Interactive Brokers',
      blurb: 'Refer a friend: you get a reward, they get IBKR stock.',
      url: 'https://www.interactivebrokers.com/',
      accent: '#d9241c'
    },
    {
      id: 'public',
      name: 'Public',
      blurb: 'Both get a free stock slice after first deposit.',
      url: 'https://public.com/',
      accent: '#7e3ff2'
    },
    {
      id: 'etoro',
      name: 'eToro',
      blurb: 'Both get a reward after a qualifying deposit.',
      url: 'https://www.etoro.com/',
      accent: '#13c2c2'
    }
  ];

  const RESEARCH_OFFERS = [
    {
      id: 'tradingview',
      name: 'TradingView',
      blurb: 'Both get credits toward a paid plan.',
      url: 'https://www.tradingview.com/',
      accent: '#2962ff'
    },
    {
      id: 'seekingalpha',
      name: 'Seeking Alpha',
      blurb: 'Friend gets a free trial; you get credits if they convert.',
      url: 'https://seekingalpha.com/',
      accent: '#ff6f3c'
    }
  ];

  const CRYPTO_OFFERS = [
    {
      id: 'coinbase',
      name: 'Coinbase',
      blurb: 'Both get a sign-up reward after first qualifying trade.',
      url: 'https://www.coinbase.com/',
      accent: '#0052ff'
    },
    {
      id: 'kraken',
      name: 'Kraken',
      blurb: 'Refer a friend and both earn a reward after trading.',
      url: 'https://www.kraken.com/',
      accent: '#5741d9'
    },
    {
      id: 'gemini',
      name: 'Gemini',
      blurb: 'Both get a reward after a qualifying trade.',
      url: 'https://www.gemini.com/',
      accent: '#00dcfa'
    },
    {
      id: 'binanceus',
      name: 'Binance.US',
      blurb: 'Both get a reward after qualifying activity.',
      url: 'https://www.binance.us/',
      accent: '#f0b90b'
    },
    {
      id: 'cryptocom',
      name: 'Crypto.com',
      blurb: 'Both get a CRO reward after qualifying staking.',
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
    DISCLOSURE: 'Some links below are referral links. I may earn a commission at no cost to you. All bonuses listed are real offers for you.'
  };
})(typeof window !== 'undefined' ? window : globalThis);
