/**
 * Tactical Asset Allocation (TAA) Engine - Pure JavaScript
 * Replicates Portfolio Visualizer's TAA methodology.
 * Data source: Yahoo Finance via CORS proxy.
 */

// ============================================================
// DATA FETCHING FROM YAHOO FINANCE
// ============================================================

const CORS_PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
];

let currentProxyIdx = 0;

async function fetchYahooFinanceData(ticker, startDate, endDate) {
    const period1 = Math.floor(new Date(startDate).getTime() / 1000);
    const period2 = Math.floor(new Date(endDate).getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1mo&includeAdjustedClose=true`;

    // Try each proxy
    for (let attempt = 0; attempt < CORS_PROXIES.length; attempt++) {
        const proxyIdx = (currentProxyIdx + attempt) % CORS_PROXIES.length;
        const proxyUrl = CORS_PROXIES[proxyIdx] + encodeURIComponent(url);
        try {
            const response = await fetch(proxyUrl);
            if (!response.ok) continue;
            const data = await response.json();
            currentProxyIdx = proxyIdx;
            return parseYahooResponse(data, ticker);
        } catch (e) {
            console.warn(`Proxy ${proxyIdx} failed for ${ticker}:`, e.message);
        }
    }

    throw new Error(`Failed to fetch data for ${ticker} from Yahoo Finance`);
}

function parseYahooResponse(data, ticker) {
    const result = data.chart?.result?.[0];
    if (!result) throw new Error(`No data for ${ticker}`);

    const timestamps = result.timestamp;
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose
        || result.indicators?.quote?.[0]?.close;

    if (!timestamps || !adjClose) throw new Error(`Incomplete data for ${ticker}`);

    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (adjClose[i] != null) {
            prices.push({
                date: new Date(timestamps[i] * 1000),
                price: adjClose[i]
            });
        }
    }
    return prices;
}

async function fetchMultipleTickers(tickers, startYear, endYear) {
    // Extend start by 2 years for lookback warmup
    const start = `${startYear - 2}-01-01`;
    const end = `${endYear}-12-31`;

    updateLoadingText('Fetching data from Yahoo Finance...');
    const allData = {};
    const errors = [];

    // Fetch all tickers in parallel
    const promises = tickers.map(async (ticker) => {
        try {
            updateLoadingText(`Fetching ${ticker}...`);
            const data = await fetchYahooFinanceData(ticker, start, end);
            allData[ticker] = data;
        } catch (e) {
            errors.push(`${ticker}: ${e.message}`);
        }
    });

    await Promise.all(promises);

    if (errors.length > 0 && Object.keys(allData).length === 0) {
        throw new Error('Failed to fetch data: ' + errors.join('; '));
    }

    return allData;
}

function alignMonthlyPrices(allData, tickers) {
    // Collect all unique year-month keys
    const monthMap = {};
    for (const ticker of tickers) {
        const data = allData[ticker];
        if (!data) continue;
        for (const pt of data) {
            const key = `${pt.date.getFullYear()}-${String(pt.date.getMonth() + 1).padStart(2, '0')}`;
            if (!monthMap[key]) monthMap[key] = { date: pt.date };
            monthMap[key][ticker] = pt.price;
        }
    }

    // Sort by date, keep only months where all main tickers have data
    const sortedKeys = Object.keys(monthMap).sort();
    const aligned = [];
    for (const key of sortedKeys) {
        const row = monthMap[key];
        let hasAll = true;
        for (const t of tickers) {
            if (row[t] == null) { hasAll = false; break; }
        }
        if (hasAll) {
            aligned.push(row);
        }
    }
    return aligned;
}

// ============================================================
// FINANCIAL METRICS
// ============================================================

function computeReturns(values) {
    const returns = [];
    for (let i = 1; i < values.length; i++) {
        returns.push(values[i] / values[i - 1] - 1);
    }
    return returns;
}

function computeCAGR(startVal, endVal, years) {
    if (years <= 0 || startVal <= 0) return 0;
    return Math.pow(endVal / startVal, 1 / years) - 1;
}

function computeStdDev(returns) {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(12); // Annualize
}

function computeSharpeRatio(returns, rfRate = 0) {
    if (returns.length < 2) return 0;
    const monthlyRf = Math.pow(1 + rfRate, 1 / 12) - 1;
    const excessReturns = returns.map(r => r - monthlyRf);
    const mean = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
    const variance = excessReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (excessReturns.length - 1);
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (mean / std) * Math.sqrt(12);
}

function computeSortinoRatio(returns, rfRate = 0) {
    if (returns.length < 2) return 0;
    const monthlyRf = Math.pow(1 + rfRate, 1 / 12) - 1;
    const excessReturns = returns.map(r => r - monthlyRf);
    const meanExcess = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
    const downside = excessReturns.filter(r => r < 0);
    if (downside.length === 0) return meanExcess > 0 ? 99.99 : 0;
    const downsideVar = downside.reduce((sum, r) => sum + r * r, 0) / downside.length;
    const downsideStd = Math.sqrt(downsideVar) * Math.sqrt(12);
    if (downsideStd === 0) return 0;
    return (meanExcess * 12) / downsideStd;
}

function computeDrawdowns(portfolioValues) {
    const drawdowns = [];
    let peak = portfolioValues[0];
    for (const val of portfolioValues) {
        if (val > peak) peak = val;
        drawdowns.push(val / peak - 1);
    }
    return drawdowns;
}

function computeMaxDrawdown(portfolioValues) {
    const dd = computeDrawdowns(portfolioValues);
    return Math.min(...dd);
}

function computeAnnualReturns(dates, values) {
    const annual = {};
    let prevYearEnd = { year: null, val: null };

    for (let i = 0; i < dates.length; i++) {
        const year = dates[i].getFullYear();
        if (prevYearEnd.year === null) {
            prevYearEnd = { year, val: values[i] };
            continue;
        }
        annual[year] = { endVal: values[i] };
    }

    // Recalculate properly
    const yearData = {};
    for (let i = 0; i < dates.length; i++) {
        const y = dates[i].getFullYear();
        if (!yearData[y]) yearData[y] = { first: values[i], last: values[i], firstIdx: i };
        yearData[y].last = values[i];
    }

    const result = {};
    const years = Object.keys(yearData).map(Number).sort();
    for (let yi = 0; yi < years.length; yi++) {
        const y = years[yi];
        let startVal;
        if (yi === 0) {
            startVal = yearData[y].first;
        } else {
            startVal = yearData[years[yi - 1]].last;
        }
        const endVal = yearData[y].last;
        result[y] = startVal > 0 ? (endVal / startVal - 1) : 0;
    }
    return result;
}

function computeMonthlyReturns(dates, values) {
    const result = {};
    for (let i = 1; i < dates.length; i++) {
        const year = dates[i].getFullYear();
        const month = dates[i].getMonth() + 1;
        if (!result[year]) result[year] = {};
        result[year][month] = values[i - 1] > 0 ? (values[i] / values[i - 1] - 1) : 0;
    }
    return result;
}

function computeRollingReturns(dates, values, windowYears) {
    const windowMonths = windowYears * 12;
    const rolling = { dates: [], values: [] };
    for (let i = windowMonths; i < values.length; i++) {
        const startVal = values[i - windowMonths];
        const endVal = values[i];
        if (startVal > 0) {
            const totalRet = endVal / startVal;
            const annRet = Math.pow(totalRet, 1 / windowYears) - 1;
            rolling.dates.push(dates[i]);
            rolling.values.push(annRet * 100);
        }
    }
    return rolling;
}

function computeAllMetrics(dates, values) {
    const returns = computeReturns(values);
    const years = (dates[dates.length - 1] - dates[0]) / (365.25 * 24 * 3600 * 1000);
    const annualRets = computeAnnualReturns(dates, values);
    const annualValues = Object.values(annualRets);

    return {
        initial_balance: Math.round(values[0] * 100) / 100,
        final_balance: Math.round(values[values.length - 1] * 100) / 100,
        cagr: Math.round(computeCAGR(values[0], values[values.length - 1], years) * 10000) / 100,
        std_dev: Math.round(computeStdDev(returns) * 10000) / 100,
        sharpe_ratio: Math.round(computeSharpeRatio(returns) * 100) / 100,
        sortino_ratio: Math.round(computeSortinoRatio(returns) * 100) / 100,
        max_drawdown: Math.round(computeMaxDrawdown(values) * 10000) / 100,
        best_year: annualValues.length ? Math.round(Math.max(...annualValues) * 10000) / 100 : 0,
        worst_year: annualValues.length ? Math.round(Math.min(...annualValues) * 10000) / 100 : 0,
    };
}

// ============================================================
// PORTFOLIO WEIGHTING SCHEMES
// ============================================================

function equalWeight(n) {
    return new Array(n).fill(1 / n);
}

function inverseVolWeights(covMatrix) {
    const n = covMatrix.length;
    if (n === 0) return [];
    if (n === 1) return [1];
    const vols = covMatrix.map((row, i) => Math.sqrt(Math.max(row[i], 1e-10)));
    const invVols = vols.map(v => 1 / v);
    const sum = invVols.reduce((a, b) => a + b, 0);
    return invVols.map(v => v / sum);
}

function minVarianceWeights(covMatrix) {
    const n = covMatrix.length;
    if (n === 0) return [];
    if (n === 1) return [1];

    // Analytical solution for min variance (long-only approximation via inverse vol)
    // For proper min variance, use iterative method
    let weights = equalWeight(n);

    // Simple iterative optimization
    for (let iter = 0; iter < 500; iter++) {
        // Compute gradient
        const grad = [];
        for (let i = 0; i < n; i++) {
            let g = 0;
            for (let j = 0; j < n; j++) {
                g += 2 * covMatrix[i][j] * weights[j];
            }
            grad.push(g);
        }

        // Step
        const lr = 0.01;
        for (let i = 0; i < n; i++) {
            weights[i] = Math.max(0.001, weights[i] - lr * grad[i]);
        }

        // Normalize
        const sum = weights.reduce((a, b) => a + b, 0);
        weights = weights.map(w => w / sum);
    }

    return weights;
}

function riskParityWeights(covMatrix) {
    const n = covMatrix.length;
    if (n === 0) return [];
    if (n === 1) return [1];

    // Start with inverse vol weights
    let weights = inverseVolWeights(covMatrix);

    // Iterative risk parity
    for (let iter = 0; iter < 500; iter++) {
        // Portfolio variance
        let portVar = 0;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                portVar += weights[i] * weights[j] * covMatrix[i][j];
            }
        }
        const portVol = Math.sqrt(Math.max(portVar, 1e-10));

        // Risk contributions
        const marginal = [];
        for (let i = 0; i < n; i++) {
            let mc = 0;
            for (let j = 0; j < n; j++) {
                mc += covMatrix[i][j] * weights[j];
            }
            marginal.push(mc);
        }

        const riskContrib = weights.map((w, i) => w * marginal[i] / portVol);
        const targetRC = portVol / n;

        // Adjust weights
        for (let i = 0; i < n; i++) {
            const ratio = targetRC / Math.max(riskContrib[i], 1e-10);
            weights[i] *= Math.pow(ratio, 0.3); // Damped update
        }

        // Normalize
        const sum = weights.reduce((a, b) => a + b, 0);
        weights = weights.map(w => Math.max(0.001, w / sum));
        const sum2 = weights.reduce((a, b) => a + b, 0);
        weights = weights.map(w => w / sum2);
    }

    return weights;
}

function computeCovMatrix(returnsMatrix) {
    // returnsMatrix: array of arrays, each inner array = returns for one asset
    const n = returnsMatrix.length;
    const T = returnsMatrix[0].length;

    const means = returnsMatrix.map(r => r.reduce((a, b) => a + b, 0) / T);
    const cov = [];

    for (let i = 0; i < n; i++) {
        cov.push([]);
        for (let j = 0; j < n; j++) {
            let sum = 0;
            for (let t = 0; t < T; t++) {
                sum += (returnsMatrix[i][t] - means[i]) * (returnsMatrix[j][t] - means[j]);
            }
            cov[i].push((sum / (T - 1)) * 12); // Annualize
        }
    }
    return cov;
}

// ============================================================
// TAA MODELS
// ============================================================

function simulatePortfolio(monthlyData, allocations, tickers, cashTicker, initialInvestment) {
    const dates = [];
    const values = [];
    const allocHistory = [];

    // Find first month with non-zero allocation
    let startIdx = 0;
    for (let i = 0; i < allocations.length; i++) {
        const totalAlloc = tickers.reduce((sum, t) => sum + (allocations[i][t] || 0), 0);
        if (totalAlloc > 0) { startIdx = i; break; }
    }
    if (startIdx === 0) startIdx = 1;

    let portfolioValue = initialInvestment;
    dates.push(monthlyData[startIdx].date);
    values.push(portfolioValue);
    allocHistory.push(allocations[startIdx] || {});

    for (let i = startIdx + 1; i < monthlyData.length; i++) {
        const prevAlloc = allocations[i - 1] || {};
        let portReturn = 0;
        let totalAllocWeight = 0;

        for (const ticker of tickers) {
            const w = prevAlloc[ticker] || 0;
            if (w > 0 && monthlyData[i][ticker] && monthlyData[i - 1][ticker]) {
                const ret = monthlyData[i][ticker] / monthlyData[i - 1][ticker] - 1;
                portReturn += w * ret;
                totalAllocWeight += w;
            }
        }

        // Cash return
        const cashWeight = Math.max(0, 1 - totalAllocWeight);
        if (cashWeight > 0 && cashTicker && monthlyData[i][cashTicker] && monthlyData[i - 1][cashTicker]) {
            const cashRet = monthlyData[i][cashTicker] / monthlyData[i - 1][cashTicker] - 1;
            portReturn += cashWeight * cashRet;
        }

        portfolioValue *= (1 + portReturn);
        dates.push(monthlyData[i].date);
        values.push(portfolioValue);
        allocHistory.push(allocations[i] || {});
    }

    return { dates, values, allocHistory };
}

function runMovingAverage(monthlyData, tickers, params) {
    const maPeriod = params.ma_period || 10;
    const useCrossover = params.use_crossover || false;
    const shortPeriod = params.short_period || 1;

    const allocations = [];

    for (let i = 0; i < monthlyData.length; i++) {
        const alloc = {};

        if (i < maPeriod) {
            allocations.push(alloc);
            continue;
        }

        let signalCount = 0;
        const signals = {};

        for (const ticker of tickers) {
            // Compute moving average
            let maLong = 0;
            let count = 0;
            for (let j = i - maPeriod + 1; j <= i; j++) {
                if (monthlyData[j] && monthlyData[j][ticker]) {
                    maLong += monthlyData[j][ticker];
                    count++;
                }
            }
            maLong = count > 0 ? maLong / count : 0;

            let signal = false;
            if (useCrossover) {
                let maShort = 0;
                let sCount = 0;
                for (let j = i - shortPeriod + 1; j <= i; j++) {
                    if (monthlyData[j] && monthlyData[j][ticker]) {
                        maShort += monthlyData[j][ticker];
                        sCount++;
                    }
                }
                maShort = sCount > 0 ? maShort / sCount : 0;
                signal = maShort >= maLong;
            } else {
                const currentPrice = monthlyData[i][ticker];
                signal = currentPrice >= maLong;
            }

            if (signal) {
                signals[ticker] = true;
                signalCount++;
            }
        }

        if (signalCount > 0) {
            const w = 1 / signalCount;
            for (const t of tickers) {
                alloc[t] = signals[t] ? w : 0;
            }
        }

        allocations.push(alloc);
    }

    return allocations;
}

function runDualMomentum(monthlyData, tickers, params, cashTicker) {
    const lookback = params.lookback || 12;
    const excludeRecent = params.exclude_recent != null ? params.exclude_recent : 1;
    const nTop = params.n_top || 1;

    const allocations = [];
    const startIdx = lookback + excludeRecent;

    for (let i = 0; i < monthlyData.length; i++) {
        const alloc = {};

        if (i < startIdx) {
            allocations.push(alloc);
            continue;
        }

        const endIdx = excludeRecent > 0 ? i - excludeRecent : i;
        const startMom = i - lookback;

        if (startMom < 0 || endIdx <= startMom) {
            allocations.push(alloc);
            continue;
        }

        // Calculate momentum for each asset
        const moms = [];
        for (const ticker of tickers) {
            const pStart = monthlyData[startMom][ticker];
            const pEnd = monthlyData[endIdx][ticker];
            if (pStart && pEnd && pStart > 0) {
                moms.push({ ticker, mom: pEnd / pStart - 1 });
            } else {
                moms.push({ ticker, mom: -999 });
            }
        }

        // Risk-free momentum
        let rfMom = 0;
        if (cashTicker && monthlyData[startMom][cashTicker] && monthlyData[endIdx][cashTicker]) {
            const rfStart = monthlyData[startMom][cashTicker];
            const rfEnd = monthlyData[endIdx][cashTicker];
            if (rfStart > 0) rfMom = rfEnd / rfStart - 1;
        }

        // Sort by relative momentum
        moms.sort((a, b) => b.mom - a.mom);
        const selected = [];

        for (let j = 0; j < Math.min(nTop, moms.length); j++) {
            if (moms[j].mom > rfMom) {
                selected.push(moms[j].ticker);
            }
        }

        if (selected.length > 0) {
            const w = 1 / selected.length;
            for (const t of selected) alloc[t] = w;
        }

        allocations.push(alloc);
    }

    return allocations;
}

function runRelativeStrength(monthlyData, tickers, params) {
    const lookback = params.lookback || 12;
    const excludeRecent = params.exclude_recent != null ? params.exclude_recent : 1;
    const nTop = params.n_top || 3;

    const allocations = [];
    const startIdx = lookback + excludeRecent;

    for (let i = 0; i < monthlyData.length; i++) {
        const alloc = {};

        if (i < startIdx) {
            allocations.push(alloc);
            continue;
        }

        const endIdx = excludeRecent > 0 ? i - excludeRecent : i;
        const startMom = i - lookback;

        if (startMom < 0 || endIdx <= startMom) {
            allocations.push(alloc);
            continue;
        }

        const moms = [];
        for (const ticker of tickers) {
            const pStart = monthlyData[startMom][ticker];
            const pEnd = monthlyData[endIdx][ticker];
            if (pStart && pEnd && pStart > 0) {
                moms.push({ ticker, mom: pEnd / pStart - 1 });
            }
        }

        moms.sort((a, b) => b.mom - a.mom);
        const selected = moms.slice(0, nTop);

        if (selected.length > 0) {
            const w = 1 / selected.length;
            for (const s of selected) alloc[s.ticker] = w;
        }

        allocations.push(alloc);
    }

    return allocations;
}

function runAdaptiveAllocation(monthlyData, tickers, params) {
    const momLookback = params.mom_lookback || 6;
    const volLookback = params.vol_lookback || 3;
    const nTop = params.n_top || 5;
    const weighting = params.weighting || 'min_variance';
    const excludeRecent = params.exclude_recent != null ? params.exclude_recent : 1;

    const allocations = [];
    const startIdx = Math.max(momLookback + excludeRecent, volLookback + 1);

    for (let i = 0; i < monthlyData.length; i++) {
        const alloc = {};

        if (i < startIdx) {
            allocations.push(alloc);
            continue;
        }

        // Step 1: Momentum ranking
        const endIdx = excludeRecent > 0 ? i - excludeRecent : i;
        const startMom = i - momLookback;

        const moms = [];
        for (const ticker of tickers) {
            const pStart = monthlyData[startMom]?.[ticker];
            const pEnd = monthlyData[endIdx]?.[ticker];
            if (pStart && pEnd && pStart > 0) {
                moms.push({ ticker, mom: pEnd / pStart - 1 });
            }
        }

        moms.sort((a, b) => b.mom - a.mom);
        const selected = moms.slice(0, Math.min(nTop, moms.length)).filter(m => m.mom > -999);

        if (selected.length === 0) {
            allocations.push(alloc);
            continue;
        }

        const selectedTickers = selected.map(s => s.ticker);

        // Step 2: Compute weights
        if (weighting === 'equal' || selectedTickers.length === 1) {
            const w = 1 / selectedTickers.length;
            for (const t of selectedTickers) alloc[t] = w;
        } else {
            // Compute returns for vol lookback
            const returnsMatrix = [];
            for (const t of selectedTickers) {
                const rets = [];
                for (let j = Math.max(1, i - volLookback); j <= i; j++) {
                    if (monthlyData[j][t] && monthlyData[j - 1][t] && monthlyData[j - 1][t] > 0) {
                        rets.push(monthlyData[j][t] / monthlyData[j - 1][t] - 1);
                    }
                }
                returnsMatrix.push(rets);
            }

            // Ensure all same length
            const minLen = Math.min(...returnsMatrix.map(r => r.length));
            if (minLen < 2) {
                const w = 1 / selectedTickers.length;
                for (const t of selectedTickers) alloc[t] = w;
            } else {
                const trimmed = returnsMatrix.map(r => r.slice(r.length - minLen));
                const cov = computeCovMatrix(trimmed);

                let weights;
                if (weighting === 'risk_parity') {
                    weights = riskParityWeights(cov);
                } else {
                    weights = minVarianceWeights(cov);
                }

                for (let j = 0; j < selectedTickers.length; j++) {
                    alloc[selectedTickers[j]] = weights[j];
                }
            }
        }

        allocations.push(alloc);
    }

    return allocations;
}

function runTargetVolatility(monthlyData, tickers, params) {
    const targetVol = (params.target_vol || 10) / 100;
    const volLookback = params.vol_lookback || 3;
    const n = tickers.length;
    const baseW = 1 / n;

    const allocations = [];

    for (let i = 0; i < monthlyData.length; i++) {
        const alloc = {};

        if (i < volLookback + 1) {
            allocations.push(alloc);
            continue;
        }

        // Compute realized portfolio volatility
        const portReturns = [];
        for (let j = Math.max(1, i - volLookback); j <= i; j++) {
            let portRet = 0;
            for (const t of tickers) {
                if (monthlyData[j][t] && monthlyData[j - 1][t] && monthlyData[j - 1][t] > 0) {
                    portRet += baseW * (monthlyData[j][t] / monthlyData[j - 1][t] - 1);
                }
            }
            portReturns.push(portRet);
        }

        if (portReturns.length < 2) {
            allocations.push(alloc);
            continue;
        }

        const mean = portReturns.reduce((a, b) => a + b, 0) / portReturns.length;
        const variance = portReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (portReturns.length - 1);
        const realizedVol = Math.sqrt(variance) * Math.sqrt(12);

        const scale = realizedVol > 0 ? Math.min(targetVol / realizedVol, 1.0) : 1.0;

        for (const t of tickers) {
            alloc[t] = baseW * scale;
        }

        allocations.push(alloc);
    }

    return allocations;
}

function runSeasonal(monthlyData, tickers, params) {
    const avoidMonths = params.avoid_months || [5, 6, 7, 8, 9, 10];
    const n = tickers.length;

    const allocations = [];

    for (let i = 0; i < monthlyData.length; i++) {
        const alloc = {};
        const month = monthlyData[i].date.getMonth() + 1;

        if (!avoidMonths.includes(month)) {
            const w = 1 / n;
            for (const t of tickers) alloc[t] = w;
        }

        allocations.push(alloc);
    }

    return allocations;
}

function runMarketValuation(monthlyData, tickers, params) {
    // Simplified PE10 model without external data
    // Uses a simple valuation proxy based on trailing returns
    const pe10Low = params.pe10_low || 14;
    const pe10High = params.pe10_high || 22;
    const stockAllocHigh = (params.stock_alloc_high_pe || 40) / 100;
    const stockAllocMid = (params.stock_alloc_mid_pe || 60) / 100;
    const stockAllocLow = (params.stock_alloc_low_pe || 80) / 100;
    const stockTicker = params.stock_ticker || tickers[0];
    const bondTicker = params.bond_ticker || (tickers[1] || tickers[0]);

    // Use a simple estimated PE10 based on historical average PE of ~16.8
    // and scale by trailing 12m return relative to historical average (~10%)
    const allocations = [];

    for (let i = 0; i < monthlyData.length; i++) {
        const alloc = {};

        // Simple heuristic: use trailing 12m equity return to estimate relative valuation
        let estimatedPE10 = 20; // Default mid-range
        if (i >= 12 && monthlyData[i][stockTicker] && monthlyData[i - 12][stockTicker]) {
            const trailing12m = monthlyData[i][stockTicker] / monthlyData[i - 12][stockTicker] - 1;
            // Higher trailing returns suggest higher valuations
            estimatedPE10 = 16.8 * (1 + trailing12m);
        }

        let stockAlloc;
        if (estimatedPE10 >= pe10High) {
            stockAlloc = stockAllocHigh;
        } else if (estimatedPE10 >= pe10Low) {
            stockAlloc = stockAllocMid;
        } else {
            stockAlloc = stockAllocLow;
        }

        alloc[stockTicker] = stockAlloc;
        if (bondTicker !== stockTicker) {
            alloc[bondTicker] = 1 - stockAlloc;
        }

        allocations.push(alloc);
    }

    return allocations;
}

function runBuyAndHold(monthlyData, tickers) {
    const n = tickers.length;
    const w = 1 / n;
    return monthlyData.map(() => {
        const alloc = {};
        for (const t of tickers) alloc[t] = w;
        return alloc;
    });
}

// ============================================================
// MAIN BACKTEST ORCHESTRATOR
// ============================================================

async function runTAABacktest(config) {
    const {
        model, tickers, benchmarkTicker, cashTicker,
        startYear, endYear, initialInvestment, params
    } = config;

    // Determine all tickers to fetch
    const allTickers = [...new Set([...tickers, ...(cashTicker ? [cashTicker] : []), ...(benchmarkTicker ? [benchmarkTicker] : [])])];

    // Fetch data
    const rawData = await fetchMultipleTickers(allTickers, startYear, endYear);

    // Align to monthly
    updateLoadingText('Processing data...');
    const monthlyData = alignMonthlyPrices(rawData, tickers);

    if (monthlyData.length < 13) {
        throw new Error('Insufficient data. Need at least 13 months of price data.');
    }

    // Also add cash/benchmark data to monthly
    for (const row of monthlyData) {
        if (cashTicker && rawData[cashTicker]) {
            const match = rawData[cashTicker].find(p =>
                p.date.getFullYear() === row.date.getFullYear() &&
                p.date.getMonth() === row.date.getMonth()
            );
            if (match) row[cashTicker] = match.price;
        }
        if (benchmarkTicker && rawData[benchmarkTicker]) {
            const match = rawData[benchmarkTicker].find(p =>
                p.date.getFullYear() === row.date.getFullYear() &&
                p.date.getMonth() === row.date.getMonth()
            );
            if (match) row[benchmarkTicker] = match.price;
        }
    }

    updateLoadingText('Running TAA model...');

    // Run model
    let allocations;
    switch (model) {
        case 'moving_average':
            allocations = runMovingAverage(monthlyData, tickers, params);
            break;
        case 'dual_momentum':
            allocations = runDualMomentum(monthlyData, tickers, params, cashTicker);
            break;
        case 'relative_strength':
            allocations = runRelativeStrength(monthlyData, tickers, params);
            break;
        case 'adaptive_allocation':
            allocations = runAdaptiveAllocation(monthlyData, tickers, params);
            break;
        case 'target_volatility':
            allocations = runTargetVolatility(monthlyData, tickers, params);
            break;
        case 'market_valuation':
            allocations = runMarketValuation(monthlyData, tickers, params);
            break;
        case 'seasonal':
            allocations = runSeasonal(monthlyData, tickers, params);
            break;
        default:
            throw new Error(`Unknown model: ${model}`);
    }

    // Simulate
    updateLoadingText('Simulating portfolio...');
    const result = simulatePortfolio(monthlyData, allocations, tickers, cashTicker, initialInvestment);

    // Compute metrics
    const metrics = computeAllMetrics(result.dates, result.values);
    const drawdowns = computeDrawdowns(result.values);
    const annualReturns = computeAnnualReturns(result.dates, result.values);
    const monthlyReturns = computeMonthlyReturns(result.dates, result.values);
    const rolling1y = computeRollingReturns(result.dates, result.values, 1);
    const rolling3y = computeRollingReturns(result.dates, result.values, 3);
    const rolling5y = computeRollingReturns(result.dates, result.values, 5);

    // Benchmark
    let benchmark = null;
    if (benchmarkTicker) {
        const benchAllocations = monthlyData.map(() => ({ [benchmarkTicker]: 1 }));
        const benchResult = simulatePortfolio(monthlyData, benchAllocations, [benchmarkTicker], null, initialInvestment);
        if (benchResult.values.length > 1) {
            const benchMetrics = computeAllMetrics(benchResult.dates, benchResult.values);
            const benchDD = computeDrawdowns(benchResult.values);
            const benchAnnual = computeAnnualReturns(benchResult.dates, benchResult.values);

            benchmark = {
                ticker: benchmarkTicker,
                metrics: benchMetrics,
                growth_dates: benchResult.dates,
                growth_values: benchResult.values,
                dd_values: benchDD.map(d => d * 100),
                annual_returns: Object.fromEntries(Object.entries(benchAnnual).map(([k, v]) => [k, Math.round(v * 10000) / 100]))
            };
        }
    }

    // Format allocations
    const allocDates = result.dates;
    const allocData = {};
    for (const t of tickers) allocData[t] = [];
    for (const a of result.allocHistory) {
        for (const t of tickers) {
            allocData[t].push(Math.round((a[t] || 0) * 10000) / 100);
        }
    }

    return {
        metrics,
        growth: {
            dates: result.dates,
            values: result.values.map(v => Math.round(v * 100) / 100)
        },
        drawdowns: {
            dates: result.dates,
            values: drawdowns.map(d => Math.round(d * 10000) / 100)
        },
        allocations: {
            dates: allocDates,
            data: allocData
        },
        annual_returns: Object.fromEntries(Object.entries(annualReturns).map(([k, v]) => [k, Math.round(v * 10000) / 100])),
        monthly_returns: (() => {
            const mr = {};
            for (const [year, months] of Object.entries(monthlyReturns)) {
                mr[year] = {};
                for (const [month, val] of Object.entries(months)) {
                    mr[year][month] = Math.round(val * 10000) / 100;
                }
            }
            return mr;
        })(),
        rolling_returns: {
            rolling_1y: rolling1y,
            rolling_3y: rolling3y,
            rolling_5y: rolling5y
        },
        benchmark,
        tickers
    };
}
