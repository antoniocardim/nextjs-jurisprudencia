import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Head from 'next/head';
import Link from 'next/link';
import Image from "next/image";
import logoname from '../../public/images/PT-logoLogo-STJ.png';

export default function Home() {
    const [searchTerm, setSearchTerm] = useState('');
    const [suggestions, setSuggestions] = useState<Array<{ text: string; type: string; docCount: number; totalOccurrences: number }>>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
    
    // New states for UI feedback
    const [isLoading, setIsLoading] = useState(false);
    const [hasError, setHasError] = useState(false);
    
    const containerRef = useRef<HTMLDivElement | null>(null);
    const router = useRouter();

    const handleSearch = (e?: React.FormEvent, override?: string, filterKey?: string) => {
        if (e) e.preventDefault();

        const term = (override ?? searchTerm).trim();
        if (term) {
            if (filterKey) {
                router.push(`/pesquisa?${encodeURIComponent(filterKey)}=${encodeURIComponent(term)}`);
            } else {
                router.push(`/pesquisa?q=${encodeURIComponent(term)}`);
            }
        } else {
            router.push('/pesquisa');
        }
    };

    const fetchSuggestions = async (query: string): Promise<Array<{ text: string; type: string; docCount: number; totalOccurrences: number }> | null> => {
        try {
            // Added an AbortController to handle timeouts nicely
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 5 seconds timeout
            
            const response = await fetch(`/jurisprudencia/api/autocomplete?q=${encodeURIComponent(query)}`, {
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                return null;
            }
            const data = await response.json();
            return Array.isArray(data) ? data : [];
        } catch (error) {
            return null; // Return null on timeout or network error
        }
    };

    const applySuggestion = (suggestion: { text: string; type: string; docCount: number; totalOccurrences: number }) => {
        setSearchTerm(suggestion.text);
        setShowSuggestions(false);
        setSuggestions([]);
        setActiveSuggestionIndex(-1);
        const filterKey = suggestion.type !== "q" ? suggestion.type : undefined;
        handleSearch(undefined, formatSuggestion(suggestion.text), filterKey);
    };

    useEffect(() => {
        const trimmed = searchTerm.trim();
        if (trimmed.length < 3) {
            setSuggestions([]);
            setShowSuggestions(false);
            setActiveSuggestionIndex(-1);
            setHasError(false);
            return;
        }

        const timeoutId = window.setTimeout(async () => {
            setIsLoading(true);
            setHasError(false);
            setShowSuggestions(true);
            
            const next = await fetchSuggestions(trimmed);
            
            if (next === null) {
                setHasError(true);
                setSuggestions([]);
            } else {
                // Strict Filter: Only allow suggestions that ACTUALLY start with the search term
                const validSuggestions = next.filter(item => 
                    item.text && item.text.toLowerCase().startsWith(trimmed.toLowerCase())
                );
                setSuggestions(validSuggestions);
            }
            
            setIsLoading(false);
            setActiveSuggestionIndex(-1);
        }, 300);

        return () => window.clearTimeout(timeoutId);
    }, [searchTerm]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setShowSuggestions(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (!showSuggestions) return;

        if (event.key === 'ArrowDown' && suggestions.length > 0) {
            event.preventDefault();
            setActiveSuggestionIndex((prev) => (prev + 1) % suggestions.length);
        } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
            event.preventDefault();
            setActiveSuggestionIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (activeSuggestionIndex >= 0 && suggestions.length > 0) {
                applySuggestion(suggestions[activeSuggestionIndex]);
            } else {
                handleSearch(); // If no suggestion is selected, just do a normal search
            }
        } else if (event.key === 'Escape') {
            setShowSuggestions(false);
        }
    };

    const formatSuggestion = (value: string) => {
        const lower = value.toLocaleLowerCase("pt-PT");
        return lower ? lower[0].toLocaleUpperCase("pt-PT") + lower.slice(1) : value;
    };

    const suggestionBaseStyle: React.CSSProperties = {
        transition: "background-color 0.15s ease, color 0.15s ease",
        cursor: "pointer"
    };

    const activeSuggestionStyle: React.CSSProperties = {
        backgroundColor: "var(--primary-red)",
        color: "var(--primary-gold)",
        borderColor: "var(--primary-red)"
    };

    return (
        <div className="container-fluid vh-100 d-flex flex-column justify-content-center align-items-center bg-white">
            <Head>
                <title>Jurisprudência STJ - Início</title>
            </Head>

            <div className="mb-5 text-center d-flex flex-column align-items-center">
                <Image src={logoname} alt="Logótipo STJ" height={110} width={280} />
                <h2 className="mt-3 fancy-font home-title">Jurisprudência</h2>
            </div>

            <div className="w-100 px-3 home-search-wrapper">
                <form onSubmit={handleSearch}>
                    <div className="mb-4 search-container" style={{ position: "relative" }} ref={containerRef}>
                        <div className="input-group input-group-lg shadow-sm border rounded-pill overflow-hidden">
                            <span className="input-group-text bg-white border-0 ps-4">
                                <i className="bi bi-search home-search-icon"></i>
                            </span>
                            <input
                                type="text"
                                className="form-control border-0 py-3 ps-2 home-search-input"
                                placeholder="Pesquise na jurisprudência..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                onFocus={() => setShowSuggestions(searchTerm.trim().length >= 3)}
                                onKeyDown={handleKeyDown}
                            />
                        </div>
                        
                        {/* Modified Dropdown rendering to handle Loading, Errors, and Empty States */}
                        {showSuggestions && searchTerm.trim().length >= 3 && (
                            <ul
                                className="list-group position-absolute w-100 mt-1 shadow-sm"
                                style={{ top: "100%", left: 0, zIndex: 1000, maxHeight: "360px", overflowY: "auto" }}
                            >
                                {isLoading ? (
                                    <li className="list-group-item text-muted text-center py-3">
                                        <div className="spinner-border spinner-border-sm me-2" role="status"></div>
                                        A procurar sugestões...
                                    </li>
                                ) : hasError ? (
                                    <li className="list-group-item text-danger text-center py-3">
                                        <i className="bi bi-exclamation-triangle me-2"></i>
                                        Tempo de espera esgotado ou erro de ligação.
                                    </li>
                                ) : suggestions.length === 0 ? (
                                    <li className="list-group-item text-muted text-center py-3">
                                        Nenhuma sugestão encontrada para "{searchTerm}".
                                    </li>
                                ) : (
                                    suggestions.map((item, index) => (
                                        <li
                                            key={`${item.type}-${item.text}-${index}`}
                                            className={`list-group-item list-group-item-action d-flex align-items-center justify-content-between ${index === activeSuggestionIndex ? "active" : ""}`}
                                            style={{
                                                ...suggestionBaseStyle,
                                                ...(index === activeSuggestionIndex ? activeSuggestionStyle : {})
                                            }}
                                            onMouseDown={() => applySuggestion(item)}
                                            onMouseEnter={() => setActiveSuggestionIndex(index)}
                                        >
                                            <span className="d-flex align-items-center gap-2">
                                                <span>{formatSuggestion(item.text)}</span>
                                                <span className="badge bg-light text-muted border">{item.type}</span>
                                            </span>
                                            <span className="text-muted small">{item.docCount} processos | {item.totalOccurrences} ocorrências</span>
                                        </li>
                                    ))
                                )}
                            </ul>
                        )}
                    </div>

                    <div className="d-flex justify-content-center gap-3">
                        <Link href="/pesquisa" className="btn theme-btn-secondary px-4 py-2 shadow-sm fw-bold">
                            Pesquisa Avançada
                        </Link>
                    </div>
                </form>
            </div>
        </div>
    );
}