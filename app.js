const { useState, useEffect, useMemo } = React;

const App = () => {
    const [products, setProducts] = useState([]);
    const [history, setHistory] = useState({});
    const [regexList, setRegexList] = useState(["ябълки", "круши", "портокали", "грейпфрут", "моркови", "лимони", "авокадо", "патладжан", "тиквички", "чушки", "гъби", "целина", "бадеми", "кашу", "тахан", "шам фъстък", "пиле", "овесени ядки", "тофу", "извара", "верея", "palmolive.+сапун", "medix.+сапун"]);
    const [newRegex, setNewRegex] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [status, setStatus] = useState('Готовност');

    // Помощна функция за получаване на номер на седмица (ISO)
    const getWeekNumber = (d) => {
        d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    };

    useEffect(() => {
        chrome.storage.local.get(['kaufland_history', 'kaufland_regex'], (result) => {
            if (result.kaufland_history) setHistory(result.kaufland_history);
            if (result.kaufland_regex) setRegexList(result.kaufland_regex);
        });
    }, []);

    const saveRegex = (list) => {
        setRegexList(list);
        chrome.storage.local.set({ kaufland_regex: list });
    };
    const fetchKaufland = () => {
        setIsLoading(true);
        setStatus('Зареждане на Kaufland...');

        // Pre-compile regexes for performance
        const compiledRegexes = regexList.map(r => {
            try { return new RegExp(r, 'i'); } catch (e) { return null; }
        }).filter(Boolean);

        chrome.runtime.sendMessage({
            action: "fetchCatalog",
            url: 'https://www.kaufland.bg/aktualni-predlozheniya/oferti.html'
        }, (response) => {
            if (!response?.success) {
                setStatus('Грешка при Kaufland');
                setIsLoading(false);
                return;
            }

            const html = response.data;
            // Updated regex to be a bit more robust with whitespace
            const scriptRegex = /window\.SSR\['[\w-]+'\]\s*=\s*(\{[\s\S]*?\})(?=\s*;?\s*<\/script>)/g;
            let match;
            let extracted = [];

            while ((match = scriptRegex.exec(html)) !== null) {
                try {
                    const json = JSON.parse(match[1]);

                    // Ensure we are looking at the right component data
                    if (!json.props?.offerData?.cycles) continue;

                    json.props.offerData.cycles.forEach(cycle => {
                        cycle.categories.forEach(cat => {
                            const batchMatches = (cat.offers || [])
                                .map(offer => {
                                    const title = offer.title || offer.detailTitle || "";
                                    const desc = offer.subtitle || offer.detailDescription || "";

                                    // Filter against watchlist
                                    const isWatched = compiledRegexes.some(re => re.test(title) || re.test(desc));
                                    if (!isWatched) return null;

                                    return {
                                        id: `k_${offer.id || title}`,
                                        store: 'kaufland',
                                        title: title,
                                        description: desc,
                                        unit: offer.unit || "",
                                        price: parseFloat(offer.price) || 0,
                                        formattedPrice: offer.price ? `${offer.price} €` : offer.loyaltyFormattedPrice || null,
                                        formattedOldPrice: offer.oldPrice ? `${offer.price} €` : offer.loyaltyFormattedOldPrice || null,
                                        discount: offer.discount || 0,
                                        image: offer.listImage || offer.detailImage,
                                        basePrice: offer.formattedBasePrice,
                                        isWatched: true
                                    };
                                })
                                .filter(Boolean);

                            extracted = [...extracted, ...batchMatches];
                        });
                    });
                } catch (e) {
                    console.error("Error parsing Kaufland JSON chunk", e);
                }
            }

            processNewOffers(extracted, 'Kaufland');
        });
    };

    const fetchLidl = () => {
        setIsLoading(true);
        setStatus('Зареждане на Lidl...');

        let allMatches = [];
        const fetchSize = 100;

        // Compile regex list for filtering during fetch
        const compiledRegexes = regexList.map(r => {
            try { return new RegExp(r, 'i'); } catch (e) { return null; }
        }).filter(Boolean);

        const fetchBatch = (offset) => {
            const lidlUrl = `https://www.lidl.bg/q/api/search?offset=${offset}&fetchsize=${fetchSize}&locale=bg_BG&assortment=BG&version=2.1.0&category.id=10068374`;

            chrome.runtime.sendMessage({ action: "fetchCatalog", url: lidlUrl }, (response) => {
                if (!response?.success) {
                    setStatus('Грешка при Lidl');
                    setIsLoading(false);
                    return;
                }

                try {
                    const json = JSON.parse(response.data);
                    const numFound = json.numFound || 0;

                    const batchMatches = (json.items || [])
                        .filter(i => i.gridbox?.data)
                        .map(i => {
                            const d = i.gridbox.data;
                            const title = d.fullTitle || d.title || "";
                            const desc = d.keyfacts?.description?.replace(/<[^>]*>/g, '') || "";

                            // Check if it matches watchlist
                            const isWatched = compiledRegexes.some(re => re.test(title) || re.test(desc));

                            if (!isWatched) return null;

                            return {
                                id: `l_${d.productId}`,
                                store: 'lidl',
                                title: title,
                                description: desc,
                                unit: d.price?.packaging?.text || "",
                                price: d.price?.price || d.lidlPlus?.[0]?.price?.price || 0,
                                formattedPrice: `${d.price?.price || d.lidlPlus?.[0]?.price?.price || 0} €`,
                                discount: d.price?.discount || null,
                                formattedOldPrice: d.price?.oldPrice ? `${d.price.oldPrice} €` : null,
                                image: d.image,
                                isWatched: true
                            };
                        })
                        .filter(Boolean); // Remove nulls (non-matches)

                    allMatches = [...allMatches, ...batchMatches];
                    setStatus(`Lidl: Проверени ${offset + fetchSize} от ${numFound}...`);

                    if (offset + fetchSize < numFound) {
                        fetchBatch(offset + fetchSize);
                    } else {
                        processNewOffers(allMatches, 'Lidl');
                    }
                } catch (e) {
                    setStatus('Грешка при Lidl JSON');
                    setIsLoading(false);
                }
            });
        };

        fetchBatch(0);
    };


    const processNewOffers = (newOffers, storeName) => {
        updateHistory(newOffers);
        setProducts(prev => {
            // Филтрираме старите от същия магазин, за да ги заменим с новите
            const filtered = prev.filter(p => p.store !== storeName.toLowerCase());
            return [...filtered, ...newOffers];
        });
        setStatus(`Заредени ${newOffers.length} продукта от ${storeName}`);
        setIsLoading(false);
    };

    const updateHistory = (newOffers) => {
        const now = new Date();
        const weekKey = `${now.getFullYear()}-W${getWeekNumber(now)}`;

        chrome.storage.local.get(['kaufland_history'], (result) => {
            const currentHistory = result.kaufland_history || {};
            let hasChanges = false;

            newOffers.forEach(offer => {
                if (!currentHistory[offer.id]) currentHistory[offer.id] = [];
                const historyLog = currentHistory[offer.id];

                // Проверка дали вече имаме запис за тази седмица
                const hasEntryThisWeek = historyLog.some(h => {
                    const entryDate = new Date(h.date);
                    return `${entryDate.getFullYear()}-W${getWeekNumber(entryDate)}` === weekKey;
                });

                if (!hasEntryThisWeek) {
                    historyLog.push({ price: offer.price, date: now.toISOString().split('T')[0] });
                    hasChanges = true;
                }
            });

            if (hasChanges) {
                setHistory(currentHistory);
                chrome.storage.local.set({ kaufland_history: currentHistory });
            }
        });
    };

    const sortedProducts = useMemo(() => {
        const compiledRegexes = regexList.map(r => {
            try { return new RegExp(r, 'i'); } catch (e) { return null; }
        }).filter(Boolean);

        return products.map(p => ({
            ...p,
            isWatched: compiledRegexes.some(re => re.test(p.title) || re.test(p.description))
        })).sort((a, b) => (b.isWatched - a.isWatched));
    }, [products, regexList]);

    return React.createElement('div', { className: 'p-6 max-w-7xl mx-auto font-sans text-gray-800' },
        React.createElement('header', { className: 'mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4' },
            React.createElement('div', null,
                React.createElement('h1', { className: 'text-3xl font-black text-gray-900 tracking-tight' }, 'Promo Tracker'),
                React.createElement('p', { className: 'text-blue-600 font-medium' }, status)
            ),
            React.createElement('div', { className: 'flex gap-2' },
                React.createElement('button', {
                    onClick: fetchKaufland,
                    disabled: isLoading,
                    className: 'bg-red-600 hover:bg-red-700 text-white px-5 py-2 rounded-xl font-bold shadow-lg transition-all disabled:opacity-50'
                }, 'Kaufland'),
                React.createElement('button', {
                    onClick: fetchLidl,
                    disabled: isLoading,
                    className: 'bg-blue-700 hover:bg-blue-800 text-white px-5 py-2 rounded-xl font-bold shadow-lg transition-all disabled:opacity-50'
                }, 'Lidl')
            )
        ),

        React.createElement('div', { className: 'mb-6 bg-white p-5 rounded-2xl shadow-sm border border-gray-100' },
            React.createElement('h2', { className: 'font-bold mb-3' }, 'Watchlist (Regex)'),
            React.createElement('div', { className: 'flex flex-wrap gap-2 mb-4' },
                regexList.map((r, i) => React.createElement('span', { key: i, className: 'bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-xs flex items-center gap-2' },
                    r,
                    React.createElement('button', { onClick: () => saveRegex(regexList.filter((_, idx) => idx !== i)) }, '×')
                ))
            ),
            React.createElement('div', { className: 'flex gap-2' },
                React.createElement('input', {
                    className: 'flex-grow border rounded-xl px-4 py-2 text-sm',
                    placeholder: 'Добави ключова дума...',
                    value: newRegex,
                    onChange: (e) => setNewRegex(e.target.value),
                    onKeyPress: (e) => e.key === 'Enter' && (saveRegex([...regexList, newRegex]), setNewRegex(''))
                }),
                React.createElement('button', { onClick: () => { saveRegex([...regexList, newRegex]); setNewRegex(''); }, className: 'bg-gray-800 text-white px-4 py-2 rounded-xl text-sm' }, 'Добави')
            )
        ),

        React.createElement('div', { className: 'bg-white shadow-xl rounded-2xl overflow-hidden' },
            React.createElement('table', { className: 'w-full text-left border-collapse' },
                React.createElement('thead', { className: 'bg-gray-50 border-b' },
                    React.createElement('tr', null,
                        // Removed 'Цена' from the headers array
                        ['Магазин', 'Продукт', 'История'].map(h => React.createElement('th', { key: h, className: 'p-4 text-xs font-bold text-gray-400 uppercase' }, h))
                    )
                ),
                React.createElement('tbody', null,
                    sortedProducts.map(p => React.createElement('tr', {
                        key: p.id,
                        className: `border-t hover:bg-gray-50 transition-colors ${p.isWatched ? 'bg-blue-50' : ''}`
                    },
                        // 1. Store Icon Cell
                        React.createElement('td', { className: 'p-4 text-center w-20' },
                            React.createElement('img', {
                                src: p.store === 'kaufland' ? 'icons/kaufland.ico' : 'icons/lidl.png',
                                className: 'w-8 h-8 rounded shadow-sm mx-auto',
                                loading: 'lazy'
                            })
                        ),

                        // 2. Combined Product & Price Cell
                        React.createElement('td', { className: 'p-4' },
                            React.createElement('div', { className: 'flex gap-4 items-center' },
                                React.createElement('img', { src: p.image, className: 'w-36 h-36 object-contain', loading: 'lazy' }),
                                React.createElement('div', { className: 'flex flex-col gap-1' }, // Added flex-col for vertical stacking
                                    React.createElement('div', { className: 'font-bold text-sm line-clamp-1' }, p.title + " - " + p.description),
                                    React.createElement('div', { className: 'text-[10px] text-gray-400' }, p.unit),

                                    // Price moved here
                                    React.createElement('div', { className: 'mt-1' },
                                        React.createElement('span', { className: 'font-black text-lg mr-2' }, p.formattedPrice),
                                        p.formattedOldPrice && React.createElement('span', { className: 'text-xs text-gray-400 line-through' }, p.formattedOldPrice)
                                    )
                                )
                            )
                        ),

                        // 3. History Cell
                        React.createElement('td', { className: 'p-4 w-40' },
                            React.createElement('div', { className: 'space-y-1' },
                                (history[p.id] || []).slice().reverse().slice(0, 2).map((h, idx) => React.createElement('div', { key: idx, className: 'flex justify-between text-[10px]' },
                                    React.createElement('span', { className: 'text-gray-400' }, h.date),
                                    React.createElement('span', { className: 'font-bold' }, `${h.price.toFixed(2)} €`)
                                ))
                            )
                        )
                    ))
                )
            )
        )
    );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));