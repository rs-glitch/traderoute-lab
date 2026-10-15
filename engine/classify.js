// Asset-class and sector classification for exposure analysis.
// Order of evidence: known-ETF map → provider metadata (type, sector from search) → name keywords.
// ETFs are counted by category, not looked through to their holdings (stated in the UI).

export const ASSET_CLASSES = ["US equity", "International equity", "Bonds", "Gold & commodities", "Real estate", "Crypto", "Cash", "Unclassified"];

const ETF = {
  SPY: ["US equity", "Broad market (ETF)"], VOO: ["US equity", "Broad market (ETF)"], IVV: ["US equity", "Broad market (ETF)"], VTI: ["US equity", "Broad market (ETF)"],
  QQQ: ["US equity", "Tech-heavy index (ETF)"], QQQM: ["US equity", "Tech-heavy index (ETF)"], DIA: ["US equity", "Broad market (ETF)"], IWM: ["US equity", "Small caps (ETF)"],
  XLK: ["US equity", "Technology"], XLF: ["US equity", "Financial Services"], XLE: ["US equity", "Energy"], XLV: ["US equity", "Healthcare"],
  VEA: ["International equity", "Developed markets (ETF)"], EFA: ["International equity", "Developed markets (ETF)"], VXUS: ["International equity", "Global ex-US (ETF)"],
  VWO: ["International equity", "Emerging markets (ETF)"], EEM: ["International equity", "Emerging markets (ETF)"],
  TLT: ["Bonds", "Long-term Treasuries"], IEF: ["Bonds", "Intermediate Treasuries"], SHY: ["Bonds", "Short-term Treasuries"], BIL: ["Bonds", "T-bills"],
  AGG: ["Bonds", "Aggregate bonds"], BND: ["Bonds", "Aggregate bonds"], LQD: ["Bonds", "Corporate bonds"], HYG: ["Bonds", "High-yield bonds"], TIP: ["Bonds", "Inflation-protected"],
  GLD: ["Gold & commodities", "Gold"], IAU: ["Gold & commodities", "Gold"], SLV: ["Gold & commodities", "Silver"], DBC: ["Gold & commodities", "Broad commodities"], USO: ["Gold & commodities", "Oil"],
  VNQ: ["Real estate", "REITs"], IYR: ["Real estate", "REITs"],
  IBIT: ["Crypto", "Bitcoin (ETF)"], FBTC: ["Crypto", "Bitcoin (ETF)"], ETHA: ["Crypto", "Ether (ETF)"],
  SPLG: ["US equity", "Broad market (ETF)"], ITOT: ["US equity", "Broad market (ETF)"], SCHB: ["US equity", "Broad market (ETF)"], SCHX: ["US equity", "Broad market (ETF)"], RSP: ["US equity", "Broad market (ETF)"],
  VB: ["US equity", "Small caps (ETF)"], VO: ["US equity", "Mid caps (ETF)"], VUG: ["US equity", "Growth (ETF)"], VTV: ["US equity", "Value (ETF)"],
  SCHD: ["US equity", "Dividend stocks (ETF)"], VIG: ["US equity", "Dividend stocks (ETF)"], VYM: ["US equity", "Dividend stocks (ETF)"],
  JEPI: ["US equity", "Covered-call equity income (ETF)"], JEPQ: ["US equity", "Covered-call equity income (ETF)"],
  SMH: ["US equity", "Semiconductors (ETF)"], SOXX: ["US equity", "Semiconductors (ETF)"], ARKK: ["US equity", "Innovation (ETF)"],
  VT: ["International equity", "Global stocks (ETF)"], IEFA: ["International equity", "Developed markets (ETF)"], IEMG: ["International equity", "Emerging markets (ETF)"],
  SGOV: ["Bonds", "T-bills"], VGIT: ["Bonds", "Intermediate Treasuries"], BNDX: ["Bonds", "International bonds"],
};
// Sectors for the default watchlist's single stocks, so classification also works from the offline snapshot.
const KNOWN = {
  AAPL: "Technology", MSFT: "Technology", NVDA: "Technology", GOOGL: "Communication Services", GOOG: "Communication Services",
  META: "Communication Services", AMZN: "Consumer Cyclical", TSLA: "Consumer Cyclical", JPM: "Financial Services", XOM: "Energy",
};

/**
 * @param symbol
 * @param meta  optional { type: "EQUITY"|"ETF"|"CRYPTOCURRENCY"|..., sector, name }
 * @returns {{ assetClass, sector, basis }}  basis says what the classification rests on
 */
export function classify(symbol, meta = {}) {
  const s = String(symbol).toUpperCase();
  if (ETF[s]) return { assetClass: ETF[s][0], sector: ETF[s][1], basis: "known fund" };
  const type = (meta.type || "").toUpperCase();
  if (type === "CRYPTOCURRENCY" || /-USD$/.test(s)) return { assetClass: "Crypto", sector: "Crypto", basis: "provider type" };
  if (type === "EQUITY" || KNOWN[s]) {
    const intl = /\.(TO|L|DE|PA|HK|T|AX)$/.test(s);
    return { assetClass: intl ? "International equity" : "US equity", sector: meta.sector || KNOWN[s] || "Unknown sector", basis: meta.sector ? "provider sector" : KNOWN[s] ? "built-in list" : "provider type" };
  }
  const name = (meta.name || "").toLowerCase();
  if (type === "ETF" || type === "MUTUALFUND" || name) {
    // Whole-word matching, most specific first. Equity words are checked before "income"
    // (e.g. "Equity Premium Income" is a stock fund), and "Goldman"/"Netherlands" can't match gold/ether.
    const kw = [
      [/\b(bitcoin|ether|ethereum|crypto)\b/, "Crypto", "Crypto fund"],
      [/\b(gold|silver|commodit(y|ies)|oil|metals?|mining)\b/, "Gold & commodities", "Commodity fund"],
      [/\b(real estate|reits?)\b/, "Real estate", "REITs"],
      [/\b(treasury|treasuries|bonds?|aggregate|t-bills?|fixed income|municipal|muni)\b/, "Bonds", "Bond fund"],
      [/\b(international|developed|emerging|ex-us|world|global|europe|japan|china|netherlands|germany|canada|india|brazil)\b/, "International equity", "International fund"],
      [/\b(s&p|total stock|500|nasdaq|russell|dow|equity|equities|stock|stocks|growth|value|dividend|premium income)\b/, "US equity", "Equity fund"],
    ];
    for (const [re, cls, sector] of kw) if (re.test(name)) return { assetClass: cls, sector, basis: "fund name" };
  }
  return { assetClass: "Unclassified", sector: "Unclassified", basis: "no data" };
}
