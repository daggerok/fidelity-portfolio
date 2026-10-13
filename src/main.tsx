import React, { useState, useMemo, useCallback, useRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { Upload, Filter, TrendingUp, DollarSign, BarChart3, X, Menu, Sun, Moon, FileText, ChevronDown, ChevronUp, ArrowUpDown, ArrowUp, ArrowDown, FilterX, RotateCcw, Edit3, Check } from 'lucide-react';
import Papa from 'papaparse';
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import "./index.css";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: DATA TYPES (exported for testing)
// ═══════════════════════════════════════════════════════════════════════════════

export interface OptimizedFileIndex {
    fileName: string;
    accountPrefix: string;
    earliestDate: Date;
    latestDate: Date;
    rawData: any[];
}

export interface PositionState {
    ticker: string;
    account: string;
    totalShares: number;
    totalInvested: number;
    averageBuyPrice: number;
    realizedPnL: number;
    isClosed: boolean;
}

export interface PortfolioAggregate {
    positions: Record<string, PositionState>;
    globalPnL: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: PORTFOLIO REDUCTION LOGIC (exported for testing)
// ═══════════════════════════════════════════════════════════════════════════════

export function reducePortfolioOptimized(fileIndices: OptimizedFileIndex[]): PortfolioAggregate {
    const aggregate: PortfolioAggregate = { positions: {}, globalPnL: 0 };

    if (fileIndices.length === 0) return aggregate;

    const groups: Record<string, OptimizedFileIndex[]> = {};

    for (const fileIndex of fileIndices) {
        if (!groups[fileIndex.accountPrefix]) groups[fileIndex.accountPrefix] = [];
        groups[fileIndex.accountPrefix].push(fileIndex);
    }

    for (const accountPrefix in groups) {
        const filesInGroup = groups[accountPrefix];
        filesInGroup.sort((a, b) => a.earliestDate.getTime() - b.earliestDate.getTime());
        const cleanAccountName = accountPrefix.replace('History_for_Account_', '');

        for (const file of filesInGroup) {
            const rows = file.rawData;

            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i];
                const actionStr = row['Action'] || '';
                const isBuy = actionStr.includes('YOU BOUGHT');
                const isSell = actionStr.includes('YOU SOLD');

                if (!isBuy && !isSell) continue;

                const ticker = (row['Symbol'] || '').toUpperCase().trim();
                if (!ticker) continue;

                const key = `${cleanAccountName}_${ticker}`;

                if (!aggregate.positions[key]) {
                    aggregate.positions[key] = {
                        ticker,
                        account: cleanAccountName,
                        totalShares: 0,
                        totalInvested: 0,
                        averageBuyPrice: 0,
                        realizedPnL: 0,
                        isClosed: false
                    };
                }

                const pos = aggregate.positions[key];
                const amountRaw = row['Amount ($)'] || row['Amount'] || '0';
                const quantityRaw = row['Quantity'] || '0';
                const amount = parseFloat(amountRaw.toString().replace(/[$,]/g, '')) || 0;
                const shares = Math.abs(parseFloat(quantityRaw.toString().replace(/[$,]/g, '')) || 0);
                const absAmount = Math.abs(amount);

                if (isBuy) {
                    pos.totalShares += shares;
                    pos.totalInvested += absAmount;
                    pos.averageBuyPrice = pos.totalShares > 0 ? pos.totalInvested / pos.totalShares : 0;
                    pos.isClosed = false;
                }
                else if (isSell) {
                    if (pos.totalShares > 0) {
                        const costOfSharesSold = pos.averageBuyPrice * shares;
                        const pnl = absAmount - costOfSharesSold;
                        pos.realizedPnL += pnl;
                        aggregate.globalPnL += pnl;
                        pos.totalShares -= shares;
                        pos.totalInvested -= costOfSharesSold;
                        if (pos.totalShares < 0.00001) {
                            pos.totalShares = 0;
                            pos.totalInvested = 0;
                            pos.averageBuyPrice = 0;
                            pos.isClosed = true;
                        }
                    }
                }
            }
        }
    }

    return aggregate;
}

export function parseFidelityCSVOptimized(file: File): Promise<OptimizedFileIndex> {
    return new Promise((resolve, reject) => {
        const prefixMatch = file.name.match(/^(History_for_Account_[A-Za-z0-9]+)/i);
        const accountPrefix = prefixMatch ? prefixMatch[1] : file.name.replace('.csv', '');

        file.text().then(fileContent => {
            Papa.parse(fileContent, {
                header: true,
                skipEmptyLines: true,
                complete: (results: Papa.ParseResult<any>) => {
                    const validRows = results.data.filter((row: any) => {
                        const action = row['Action'] || '';
                        return row['Run Date'] && action.startsWith('YOU');
                    });

                    if (validRows.length === 0) {
                        reject(new Error(`Файл ${file.name} не содержит финансовых транзакций.`));
                        return;
                    }

                    const latestDate = new Date((validRows[0] as any)['Run Date']);
                    const earliestDate = new Date((validRows[validRows.length - 1] as any)['Run Date']);

                    resolve({
                        fileName: file.name,
                        accountPrefix,
                        earliestDate,
                        latestDate,
                        rawData: validRows
                    });
                },
                error: (error: any) => reject(error)
            });
        }).catch(reject);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: ALIAS GENERATION (exported for testing)
// ═══════════════════════════════════════════════════════════════════════════════

export function generateAccountAliases(fileIndices: OptimizedFileIndex[]): Record<string, string> {
    if (fileIndices.length === 0) return {};

    const fileNames = fileIndices.map(f => f.fileName);
    let commonPrefix = '';

    if (fileNames.length > 1) {
        const firstName = fileNames[0];
        let prefixLen = 0;
        for (let i = 0; i < firstName.length; i++) {
            const char = firstName[i];
            let allMatch = true;
            for (const name of fileNames) {
                if (name[i] !== char) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) {
                prefixLen++;
            } else {
                break;
            }
        }
        commonPrefix = firstName.substring(0, prefixLen);
    }

    let commonSuffix = '';
    if (fileNames.length > 1) {
        const firstName = fileNames[0];
        let suffixLen = 0;
        for (let i = firstName.length - 1; i >= 0; i--) {
            const char = firstName[i];
            let allMatch = true;
            for (const name of fileNames) {
                const idx = name.length - (firstName.length - i);
                if (idx < 0 || name[idx] !== char) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) {
                suffixLen++;
            } else {
                break;
            }
        }
        commonSuffix = firstName.substring(firstName.length - suffixLen);
    }

    const aliases: Record<string, string> = {};
    const uniqueAccounts = [...new Set(fileIndices.map(f => f.accountPrefix.replace('History_for_Account_', '')))];

    for (const account of uniqueAccounts) {
        const filesForAccount = fileIndices.filter(f =>
            f.accountPrefix.replace('History_for_Account_', '') === account
        );

        if (filesForAccount.length === 1) {
            const fileName = filesForAccount[0].fileName;
            let cleaned = fileName;

            if (commonPrefix.length > 5) {
                cleaned = cleaned.substring(commonPrefix.length);
            }
            if (commonSuffix.length > 3) {
                cleaned = cleaned.substring(0, cleaned.length - commonSuffix.length);
            }
            cleaned = cleaned
                .replace(/History_for_Account_/gi, '')
                .replace(/\.csv$/i, '')
                .replace(/[-_ ]+/g, ' ')
                .trim();

            if (cleaned.length > 2 && cleaned.length < 30) {
                aliases[account] = cleaned;
            } else if (account.length > 0 && account.length < 20) {
                aliases[account] = account;
            }
        } else {
            aliases[account] = account;
        }
    }

    return aliases;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: COLUMN FILTER LOGIC (exported for testing)
// ═══════════════════════════════════════════════════════════════════════════════

export type StringOperator = 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'starts_with' | 'ends_with';
export type NumericOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
export type ColumnType = 'string' | 'number';
export interface ColumnFilter {
    operator: StringOperator | NumericOperator;
    value: string;
}
export type ColumnFilters = Record<string, ColumnFilter>;

export const STRING_OPERATORS: { value: StringOperator; label: string; symbol: string }[] = [
    { value: 'contains',     label: 'Contains',         symbol: '⊇' },
    { value: 'not_contains', label: 'Not contains',     symbol: '⊉' },
    { value: 'equals',       label: 'Equals',           symbol: '=' },
    { value: 'not_equals',   label: 'Not equals',       symbol: '≠' },
    { value: 'starts_with',  label: 'Starts with',      symbol: '⊏' },
    { value: 'ends_with',    label: 'Ends with',        symbol: '⊐' },
];

export const NUMERIC_OPERATORS: { value: NumericOperator; label: string; symbol: string }[] = [
    { value: 'eq',  label: 'Equals',              symbol: '='  },
    { value: 'neq', label: 'Not equals',          symbol: '≠'  },
    { value: 'gte', label: 'Greater or equal',    symbol: '≥'  },
    { value: 'lte', label: 'Less or equal',       symbol: '≤'  },
    { value: 'gt',  label: 'Greater than',        symbol: '>'  },
    { value: 'lt',  label: 'Less than',           symbol: '<'  },
];

export function matchesStringFilter(cellValue: string, filter: ColumnFilter): boolean {
    const op = filter.operator as StringOperator;
    const val = filter.value.toLowerCase();
    const cell = cellValue.toLowerCase();

    switch (op) {
        case 'contains':     return cell.includes(val);
        case 'not_contains': return !cell.includes(val);
        case 'equals':       return cell === val;
        case 'not_equals':   return cell !== val;
        case 'starts_with':  return cell.startsWith(val);
        case 'ends_with':    return cell.endsWith(val);
        default:             return true;
    }
}

export function matchesNumericFilter(cellValue: number, filter: ColumnFilter): boolean {
    const op = filter.operator as NumericOperator;

    // Handle empty value - match all
    if (!filter.value || filter.value.trim() === '') {
        return true;
    }

    const val = parseFloat(filter.value);

    // If value can't be parsed, don't filter
    if (isNaN(val)) {
        return true;
    }

    switch (op) {
        case 'eq':  return Math.abs(cellValue - val) < 0.0001;
        case 'neq': return Math.abs(cellValue - val) >= 0.0001;
        case 'gt':  return cellValue > val;
        case 'gte': return cellValue >= val;
        case 'lt':  return cellValue < val;
        case 'lte': return cellValue <= val;
        default:    return true;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: UI COMPONENTS (internal, not exported for testing)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Column Filter Input Component ───────────────────────────────────────────

interface ColumnFilterInputProps {
    columnKey: string;
    columnType: ColumnType;
    filter: ColumnFilter | undefined;
    onChange: (key: string, filter: ColumnFilter | null) => void;
    isDark: boolean;
    align?: 'left' | 'right' | 'center';
    placeholder?: string;
}

function ColumnFilterInput({ columnKey, columnType, filter, onChange, isDark, align = 'left', placeholder }: ColumnFilterInputProps) {
    const operators = columnType === 'number' ? NUMERIC_OPERATORS : STRING_OPERATORS;
    const defaultOp = columnType === 'number' ? 'eq' : 'contains';
    const currentOp = filter?.operator ?? defaultOp;
    const currentVal = filter?.value ?? '';
    const inputRef = useRef<HTMLInputElement>(null);

    const handleOperatorChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newOp = e.target.value as StringOperator | NumericOperator;
        onChange(columnKey, { operator: newOp, value: currentVal });
    };

    const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVal = e.target.value;
        if (newVal === '') {
            onChange(columnKey, null);
        } else {
            onChange(columnKey, { operator: currentOp, value: newVal });
        }
    };

    const handleClear = () => {
        onChange(columnKey, null);
        inputRef.current?.focus();
    };

    const selectClass = isDark
        ? "bg-slate-800 border border-white/10 text-gray-300 text-xs rounded-l-md px-1 py-1 focus:outline-none focus:border-blue-500 cursor-pointer hover:bg-slate-700 transition-colors flex-shrink-0"
        : "bg-gray-100 border border-gray-300 text-gray-700 text-xs rounded-l-md px-1 py-1 focus:outline-none focus:border-blue-500 cursor-pointer hover:bg-gray-200 transition-colors flex-shrink-0";

    const inputClass = isDark
        ? "bg-slate-800 border-y border-white/10 text-white text-xs px-2 py-1 focus:outline-none focus:border-blue-500 min-w-0 flex-1"
        : "bg-gray-100 border-y border-gray-300 text-gray-900 text-xs px-2 py-1 focus:outline-none focus:border-blue-500 min-w-0 flex-1";

    const clearClass = isDark
        ? "bg-slate-800 border border-white/10 border-l-0 text-gray-500 hover:text-red-400 rounded-r-md px-1 py-1 focus:outline-none transition-colors flex-shrink-0"
        : "bg-gray-100 border border-gray-300 border-l-0 text-gray-400 hover:text-red-500 rounded-r-md px-1 py-1 focus:outline-none transition-colors flex-shrink-0";

    const isOperatorChanged = filter?.operator !== undefined && filter?.operator !== defaultOp;
    const activeRingClass = (filter || isOperatorChanged)
        ? "ring-1 ring-blue-500 rounded-md"
        : "";

    return (
        <div className={`flex items-center w-full ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'}`}>
            <div className={`flex items-center min-w-0 max-w-full ${activeRingClass}`}>
                <select
                    value={currentOp}
                    onChange={handleOperatorChange}
                    className={selectClass}
                    title={operators.find(o => o.value === currentOp)?.label}
                >
                    {operators.map(op => (
                        <option key={op.value} value={op.value}>
                            {op.symbol}
                        </option>
                    ))}
                </select>
                <input
                    ref={inputRef}
                    type={columnType === 'number' ? 'number' : 'text'}
                    value={currentVal}
                    onChange={handleValueChange}
                    placeholder={placeholder ?? (columnType === 'number' ? '0' : 'filter…')}
                    className={inputClass}
                />
                <button
                    onClick={handleClear}
                    className={clearClass}
                    tabIndex={-1}
                    title="Clear filter"
                >
                    <X className="w-3 h-3" />
                </button>
            </div>
        </div>
    );
}

// ─── Alias Edit Modal Component ───────────────────────────────────────────────

interface AliasEditModalProps {
    account: string;
    currentAlias: string;
    suggestedAlias: string;
    onSave: (alias: string) => void;
    onClose: () => void;
    isDark: boolean;
}

function AliasEditModal({ account, currentAlias, suggestedAlias, onSave, onClose, isDark }: AliasEditModalProps) {
    const [alias, setAlias] = useState(currentAlias || suggestedAlias);
    const inputRef = useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        setAlias(currentAlias || suggestedAlias);
        setTimeout(() => inputRef.current?.select(), 100);
    }, [currentAlias, suggestedAlias]);

    const handleSave = () => {
        const trimmed = alias.trim();
        if (trimmed) {
            onSave(trimmed);
        }
        onClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSave();
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    return (
        <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
            onClick={onClose}
        >
            <div
                className={cn(
                    "rounded-2xl p-6 w-full max-w-md shadow-2xl",
                    isDark ? "bg-slate-900 border border-white/10" : "bg-white border border-gray-300"
                )}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center gap-3 mb-4">
                    <div className={cn(
                        "p-2 rounded-lg",
                        isDark ? "bg-blue-500/20" : "bg-blue-100"
                    )}>
                        <Edit3 className={cn("w-5 h-5", isDark ? "text-blue-400" : "text-blue-600")} />
                    </div>
                    <div>
                        <h3 className={cn("text-lg font-semibold", isDark ? "text-white" : "text-gray-900")}>
                            Edit Account Alias
                        </h3>
                        <p className={cn("text-sm", isDark ? "text-gray-400" : "text-gray-500")}>
                            Account: <span className="font-mono">{account}</span>
                        </p>
                    </div>
                </div>

                <div className="mb-4">
                    <label className={cn("block text-sm font-medium mb-2", isDark ? "text-gray-300" : "text-gray-700")}>
                        Alias Name
                    </label>
                    <input
                        ref={inputRef}
                        type="text"
                        value={alias}
                        onChange={e => setAlias(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Enter alias..."
                        className={cn(
                            "w-full px-4 py-3 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all",
                            isDark
                                ? "bg-slate-800 border border-white/10 text-white placeholder-gray-500"
                                : "bg-gray-100 border border-gray-300 text-gray-900 placeholder-gray-400"
                        )}
                    />
                    {suggestedAlias && suggestedAlias !== currentAlias && (
                        <p className={cn("text-xs mt-2", isDark ? "text-gray-400" : "text-gray-500")}>
                            Suggested: <button
                            type="button"
                            onClick={() => setAlias(suggestedAlias)}
                            className={cn(
                                "underline hover:no-underline",
                                isDark ? "text-blue-400" : "text-blue-600"
                            )}
                        >
                            {suggestedAlias}
                        </button>
                        </p>
                    )}
                </div>

                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        className={cn(
                            "flex-1 px-4 py-2 rounded-xl font-medium transition-all",
                            isDark
                                ? "bg-white/10 text-gray-300 hover:bg-white/20"
                                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                        )}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex-1 px-4 py-2 rounded-xl font-medium bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:opacity-90 transition-all flex items-center justify-center gap-2"
                    >
                        <Check className="w-4 h-4" />
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Account List Item with Edit ──────────────────────────────────────────────

interface AccountListItemProps {
    account: string;
    alias: string;
    onEdit: () => void;
    isSelected: boolean;
    onToggle: () => void;
    isDark: boolean;
}

function AccountListItem({ account, alias, onEdit, isSelected, onToggle, isDark }: AccountListItemProps) {
    const displayName = alias || account;

    return (
        <label className="flex items-center gap-2 cursor-pointer group py-1">
            <input
                type="checkbox"
                checked={isSelected}
                onChange={onToggle}
                className={isDark
                    ? "w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-2 focus:ring-blue-500"
                    : "w-4 h-4 rounded border-gray-400 bg-white text-blue-600 focus:ring-2 focus:ring-blue-500"
                }
            />
            <span className={isDark
                ? "text-gray-300 text-sm group-hover:text-white transition-colors flex-1"
                : "text-gray-700 text-sm group-hover:text-gray-900 transition-colors flex-1"
            }>
                #{displayName}
                {alias && account !== alias && (
                    <span className={cn("text-xs ml-1 opacity-60", isDark ? "text-gray-500" : "text-gray-400")}>
                        ({account})
                    </span>
                )}
            </span>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onEdit();
                }}
                className={cn(
                    "p-1 rounded hover:bg-white/10 transition-all opacity-0 group-hover:opacity-100",
                    isDark ? "text-gray-500 hover:text-blue-400" : "text-gray-400 hover:text-blue-600"
                )}
                title="Edit alias"
            >
                <Edit3 className="w-3.5 h-3.5" />
            </button>
        </label>
    );
}

// ─── Main App Component ───────────────────────────────────────────────────────

function App() {
    const [fileIndices, setFileIndices] = useState<OptimizedFileIndex[]>([]);
    const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
    const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
    const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'CLOSED'>('ACTIVE');
    const [isFilterOpen, setIsFilterOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [theme, setTheme] = useState<'dark' | 'light'>('dark');
    const [isFilesExpanded, setIsFilesExpanded] = useState(false);
    const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
    const [columnFilters, setColumnFilters] = useState<ColumnFilters>({});

    // Account aliases state
    const [accountAliases, setAccountAliases] = useState<Record<string, string>>({});
    const [editingAccount, setEditingAccount] = useState<string | null>(null);
    const [suggestedAliases, setSuggestedAliases] = useState<Record<string, string>>({});

    // Computed suggested aliases
    const computedSuggestedAliases = useMemo(() => {
        return generateAccountAliases(fileIndices);
    }, [fileIndices]);

    // Get display name for account
    const getAccountDisplayName = (account: string) => {
        return accountAliases[account] || account;
    };

    // Initialize/reset account aliases
    const initializeAliases = useCallback((files: OptimizedFileIndex[]) => {
        const newSuggested = generateAccountAliases(files);
        setSuggestedAliases(newSuggested);

        const newAliases: Record<string, string> = {};
        const uniqueAccounts = [...new Set(files.map(f => f.accountPrefix.replace('History_for_Account_', '')))];

        for (const account of uniqueAccounts) {
            const filesForAccount = files.filter(f =>
                f.accountPrefix.replace('History_for_Account_', '') === account
            );

            if (filesForAccount.length === 1) {
                const suggested = newSuggested[account];
                if (suggested && suggested !== account) {
                    newAliases[account] = suggested;
                }
            }
        }

        setAccountAliases(prev => {
            const updated = { ...prev };
            for (const [acc, alias] of Object.entries(newAliases)) {
                if (!updated[acc]) {
                    updated[acc] = alias;
                }
            }
            return updated;
        });
    }, []);

    // Reset function
    const handleReset = useCallback(() => {
        setSelectedAccounts([]);
        setSelectedTickers([]);
        setStatusFilter('ACTIVE');
        setSortConfig(null);
        setColumnFilters({});
        setIsFilterOpen(false);
    }, []);

    const handleMultipleFilesUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;

        const filesArray = Array.from(e.target.files);
        setIsLoading(true);

        const newIndices: OptimizedFileIndex[] = [];

        for (const file of filesArray) {
            try {
                const indexResult = await parseFidelityCSVOptimized(file);
                newIndices.push(indexResult);
            } catch (err) {
                console.error(err);
            }
        }

        const updatedFiles = [...fileIndices, ...newIndices];
        setFileIndices(updatedFiles);
        initializeAliases(updatedFiles);
        setIsLoading(false);
    };

    const handleSort = (key: string) => {
        setSortConfig(current => {
            if (current?.key === key) {
                return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
            }
            return {
                key,
                direction: ['totalShares', 'averageBuyPrice', 'realizedPnL'].includes(key) ? 'desc' : 'asc'
            };
        });
    };

    const handleColumnFilterChange = useCallback((key: string, filter: ColumnFilter | null) => {
        setColumnFilters(prev => {
            const next = { ...prev };
            if (filter === null) {
                delete next[key];
            } else {
                next[key] = filter;
            }
            return next;
        });
    }, []);

    const clearAllColumnFilters = useCallback(() => {
        setColumnFilters({});
    }, []);

    const activeFilterCount = Object.keys(columnFilters).length;

    const portfolio = useMemo(() => reducePortfolioOptimized(fileIndices), [fileIndices]);

    const uniqueAccounts = useMemo(() => {
        return Array.from(new Set(fileIndices.map(f => f.accountPrefix.replace('History_for_Account_', ''))));
    }, [fileIndices]);

    const uniqueTickers = useMemo(() => {
        const tickers = new Set<string>();
        fileIndices.forEach(f => {
            f.rawData.forEach((row: any) => {
                if (row['Symbol']) tickers.add(row['Symbol'].toUpperCase().trim());
            });
        });
        return Array.from(tickers).sort();
    }, [fileIndices]);

    const filteredPositions = useMemo(() => {
        let positions = Object.values(portfolio.positions).filter(pos => {
            const matchesAccount = selectedAccounts.length === 0 || selectedAccounts.includes(pos.account);
            const matchesTicker = selectedTickers.length === 0 || selectedTickers.includes(pos.ticker);
            const matchesStatus =
                statusFilter === 'ALL' ||
                (statusFilter === 'ACTIVE' && !pos.isClosed) ||
                (statusFilter === 'CLOSED' && pos.isClosed);

            return matchesAccount && matchesTicker && matchesStatus;
        });

        if (sortConfig) {
            positions.sort((a, b) => {
                let aValue: any = a[sortConfig.key as keyof PositionState];
                let bValue: any = b[sortConfig.key as keyof PositionState];

                if (typeof aValue === 'string') {
                    aValue = aValue.toLowerCase();
                    bValue = (bValue as string).toLowerCase();
                }

                if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }

        if (activeFilterCount > 0) {
            positions = positions.filter(pos => {
                for (const [key, filter] of Object.entries(columnFilters)) {
                    if (!filter.value) continue;

                    switch (key) {
                        case 'ticker':
                            if (!matchesStringFilter(pos.ticker, filter)) return false;
                            break;
                        case 'account':
                            if (!matchesStringFilter(pos.account, filter)) return false;
                            break;
                        case 'alias':
                        {
                            const alias = accountAliases[pos.account] || '';
                            if (!matchesStringFilter(alias, filter) && !matchesStringFilter(pos.account, filter)) return false;
                        }
                            break;
                        case 'status':
                            if (!matchesStringFilter(pos.isClosed ? 'closed' : 'active', filter)) return false;
                            break;
                        case 'totalShares':
                            if (!matchesNumericFilter(pos.totalShares, filter)) return false;
                            break;
                        case 'averageBuyPrice':
                            if (!matchesNumericFilter(pos.averageBuyPrice, filter)) return false;
                            break;
                        case 'realizedPnL':
                            if (!matchesNumericFilter(pos.realizedPnL, filter)) return false;
                            break;
                        default:
                            break;
                    }
                }
                return true;
            });
        }

        return positions;
    }, [portfolio, selectedAccounts, selectedTickers, statusFilter, sortConfig, columnFilters, activeFilterCount, accountAliases]);

    const totalFilteredPnL = useMemo(() => {
        return filteredPositions.reduce((sum, pos) => sum + pos.realizedPnL, 0);
    }, [filteredPositions]);

    const chartData = useMemo(() => {
        return filteredPositions
            .map(pos => ({
                name: `${pos.ticker}`,
                account: getAccountDisplayName(pos.account),
                'P&L': parseFloat(pos.realizedPnL.toFixed(2))
            }))
            .sort((a, b) => b['P&L'] - a['P&L'])
            .slice(0, 20);
    }, [filteredPositions, getAccountDisplayName]);

    const stats = useMemo(() => {
        const activePositions = filteredPositions.filter(p => !p.isClosed).length;
        const closedPositions = filteredPositions.filter(p => p.isClosed).length;
        const profitablePositions = filteredPositions.filter(p => p.realizedPnL > 0).length;
        return { activePositions, closedPositions, profitablePositions };
    }, [filteredPositions]);

    const CustomTooltip = ({ active, payload }: any) => {
        if (active && payload && payload.length) {
            const data = payload[0].payload;
            return (
                <div className={isDark ? "bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 shadow-xl" : "bg-white border border-gray-300 rounded-lg px-4 py-3 shadow-xl"}>
                    <p className={isDark ? "text-white font-semibold text-sm" : "text-gray-900 font-semibold text-sm"}>{data.name}</p>
                    <p className={isDark ? "text-gray-400 text-xs mb-1" : "text-gray-600 text-xs mb-1"}>#{data.account}</p>
                    <p className={`text-lg font-bold ${data['P&L'] >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${data['P&L'].toFixed(2)}
                    </p>
                </div>
            );
        }
        return null;
    };

    const isDark = theme === 'dark';

    const SortIcon = ({ colKey }: { colKey: string }) => {
        if (sortConfig?.key === colKey) {
            return sortConfig.direction === 'asc'
                ? <ArrowUp className="w-3 h-3 text-blue-400" />
                : <ArrowDown className="w-3 h-3 text-blue-400" />;
        }
        return <ArrowUpDown className="w-3 h-3 opacity-30" />;
    };

    const thBase = isDark
        ? "text-xs font-semibold text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-white/5 transition-colors select-none"
        : "text-xs font-semibold text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-200 transition-colors select-none";

    const filterRowCell = isDark
        ? "px-3 py-2 bg-slate-900/70 border-b border-white/5"
        : "px-3 py-2 bg-gray-50 border-b border-gray-200";

    return (
        <div className={isDark ? "min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900" : "min-h-screen bg-gradient-to-br from-gray-50 via-blue-50 to-gray-100"}>
            {/* Header */}
            <header className={isDark ? "border-b border-white/10 bg-black/20 backdrop-blur-xl sticky top-0 z-40" : "border-b border-gray-200 bg-white/80 backdrop-blur-xl sticky top-0 z-40"}>
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="bg-gradient-to-br from-blue-500 to-purple-600 p-2 rounded-xl">
                                <BarChart3 className="w-6 h-6 text-white" />
                            </div>
                            <div>
                                <h1 className={isDark ? "text-xl sm:text-2xl font-bold text-white" : "text-xl sm:text-2xl font-bold text-gray-900"}>
                                    Fidelity Portfolio Analyzer
                                </h1>
                                <p className={isDark ? "text-xs sm:text-sm text-gray-400 hidden sm:block" : "text-xs sm:text-sm text-gray-600 hidden sm:block"}>
                                    Event-sourced transaction analysis
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {fileIndices.length > 0 && (
                                <button
                                    onClick={handleReset}
                                    className={isDark
                                        ? "bg-white/10 hover:bg-white/20 text-white px-3 py-2 rounded-lg transition-all duration-200 flex items-center gap-2"
                                        : "bg-gray-200 hover:bg-gray-300 text-gray-900 px-3 py-2 rounded-lg transition-all duration-200 flex items-center gap-2"
                                    }
                                    title="Reset filters and sorting"
                                >
                                    <RotateCcw className="w-5 h-5" />
                                    <span className="hidden sm:inline">Reset</span>
                                </button>
                            )}
                            <button
                                onClick={() => setTheme(isDark ? 'light' : 'dark')}
                                className={isDark ? "bg-white/10 hover:bg-white/20 text-white px-3 py-2 rounded-lg transition-all duration-200 flex items-center gap-2" : "bg-gray-200 hover:bg-gray-300 text-gray-900 px-3 py-2 rounded-lg transition-all duration-200 flex items-center gap-2"}
                                title={isDark ? "Switch to light mode" : "Switch to dark mode"}
                            >
                                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                            </button>
                            {fileIndices.length > 0 && (
                                <button
                                    onClick={() => setIsFilterOpen(!isFilterOpen)}
                                    className={isDark ? "lg:hidden bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg transition-all duration-200 flex items-center gap-2" : "lg:hidden bg-gray-200 hover:bg-gray-300 text-gray-900 px-4 py-2 rounded-lg transition-all duration-200 flex items-center gap-2"}
                                >
                                    {isFilterOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </header>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
                {/* Upload Section */}
                <label className={isDark ? "block bg-gradient-to-br from-blue-900/20 to-purple-900/20 backdrop-blur-sm border border-white/10 rounded-2xl p-6 sm:p-8 mb-6 sm:mb-8 shadow-2xl cursor-pointer hover:border-white/20 transition-all duration-200" : "block bg-gradient-to-br from-blue-100/50 to-purple-100/50 backdrop-blur-sm border border-gray-300 rounded-2xl p-6 sm:p-8 mb-6 sm:mb-8 shadow-xl cursor-pointer hover:border-gray-400 transition-all duration-200"}>
                    <input
                        type="file"
                        accept=".csv"
                        multiple
                        onChange={handleMultipleFilesUpload}
                        className="hidden"
                        disabled={isLoading}
                    />
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-4 w-full sm:w-auto">
                            <div className={isDark ? "bg-blue-500/20 p-3 rounded-xl" : "bg-blue-500/30 p-3 rounded-xl"}>
                                <Upload className={isDark ? "w-6 h-6 text-blue-400" : "w-6 h-6 text-blue-600"} />
                            </div>
                            <div>
                                <div className={isDark ? "text-white font-semibold text-lg" : "text-gray-900 font-semibold text-lg"}>
                                    Upload CSV Files
                                </div>
                                <p className={isDark ? "text-gray-400 text-sm" : "text-gray-600 text-sm"}>
                                    Select one or more Fidelity activity → Orders exported files per account / year
                                </p>
                            </div>
                        </div>
                        <div className="bg-gradient-to-r from-blue-500 to-purple-600 px-6 py-3 rounded-xl">
                            <div className="text-white/80 text-xs uppercase tracking-wider">Files Loaded</div>
                            <div className="text-white text-3xl font-bold">{fileIndices.length}</div>
                        </div>
                    </div>
                    {isLoading && (
                        <div className={isDark ? "mt-4 flex items-center gap-2 text-blue-400" : "mt-4 flex items-center gap-2 text-blue-600"}>
                            <div className={isDark ? "animate-spin rounded-full h-4 w-4 border-2 border-blue-400 border-t-transparent" : "animate-spin rounded-full h-4 w-4 border-2 border-blue-600 border-t-transparent"}></div>
                            <span className="text-sm">Processing files...</span>
                        </div>
                    )}
                </label>

                {/* Uploaded Files Section */}
                {fileIndices.length > 0 && (
                    <div className={isDark ? "bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-sm border border-white/10 rounded-2xl mb-6 shadow-xl overflow-hidden" : "bg-white border border-gray-300 rounded-2xl mb-6 shadow-lg overflow-hidden"}>
                        <button
                            onClick={() => setIsFilesExpanded(!isFilesExpanded)}
                            className={isDark ? "w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors" : "w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"}
                        >
                            <div className="flex items-center gap-2">
                                <FileText className={isDark ? "w-5 h-5 text-blue-400" : "w-5 h-5 text-blue-600"} />
                                <h3 className={isDark ? "text-white font-semibold text-lg" : "text-gray-900 font-semibold text-lg"}>Uploaded Files</h3>
                                <span className={isDark ? "text-gray-400 text-sm" : "text-gray-600 text-sm"}>({fileIndices.length})</span>
                            </div>
                            {isFilesExpanded
                                ? <ChevronUp className={isDark ? "w-5 h-5 text-gray-400" : "w-5 h-5 text-gray-600"} />
                                : <ChevronDown className={isDark ? "w-5 h-5 text-gray-400" : "w-5 h-5 text-gray-600"} />}
                        </button>
                        {isFilesExpanded && (
                            <div className="p-6 pt-2">
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                    {fileIndices.map((file, idx) => (
                                        <div key={idx} className={isDark ? "bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors" : "bg-gray-50 border border-gray-200 rounded-lg p-3 hover:bg-gray-100 transition-colors"}>
                                            <div className={isDark ? "text-gray-300 text-sm font-mono truncate" : "text-gray-700 text-sm font-mono truncate"} title={file.fileName}>
                                                {file.fileName}
                                            </div>
                                            <div className={isDark ? "text-blue-400 text-xs mt-1" : "text-blue-600 text-xs mt-1"}>
                                                Account: #{getAccountDisplayName(file.accountPrefix.replace('History_for_Account_', ''))}
                                            </div>
                                            <div className={isDark ? "text-gray-500 text-xs mt-1" : "text-gray-500 text-xs mt-1"}>
                                                {file.earliestDate.toLocaleDateString()} - {file.latestDate.toLocaleDateString()}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {fileIndices.length > 0 && (
                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                        {/* Filters Sidebar */}
                        <aside className={`lg:col-span-1 ${isFilterOpen ? 'block' : 'hidden lg:block'}`}>
                            <div className="sticky top-24 space-y-4">
                                {/* Account Filter */}
                                <div className={isDark ? "bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-sm border border-white/10 rounded-2xl p-5 shadow-xl" : "bg-white border border-gray-300 rounded-2xl p-5 shadow-lg"}>
                                    <div className="flex items-center gap-2 mb-4">
                                        <Filter className={isDark ? "w-4 h-4 text-blue-400" : "w-4 h-4 text-blue-600"} />
                                        <h3 className={isDark ? "text-white font-semibold" : "text-gray-900 font-semibold"}>Accounts</h3>
                                        <span className={isDark ? "text-gray-500 text-xs" : "text-gray-400 text-xs"}>(click ✏️ to edit)</span>
                                    </div>
                                    <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {uniqueAccounts.map(acc => (
                                            <AccountListItem
                                                key={acc}
                                                account={acc}
                                                alias={accountAliases[acc] || ''}
                                                onEdit={() => setEditingAccount(acc)}
                                                isSelected={selectedAccounts.includes(acc)}
                                                onToggle={() => setSelectedAccounts(prev =>
                                                    prev.includes(acc) ? prev.filter(a => a !== acc) : [...prev, acc]
                                                )}
                                                isDark={isDark}
                                            />
                                        ))}
                                    </div>
                                </div>

                                {/* Ticker Filter */}
                                <div className={isDark ? "bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-sm border border-white/10 rounded-2xl p-5 shadow-xl" : "bg-white border border-gray-300 rounded-2xl p-5 shadow-lg"}>
                                    <div className="flex items-center gap-2 mb-4">
                                        <Filter className={isDark ? "w-4 h-4 text-purple-400" : "w-4 h-4 text-purple-600"} />
                                        <h3 className={isDark ? "text-white font-semibold" : "text-gray-900 font-semibold"}>Tickers</h3>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                                        {uniqueTickers.map(tick => (
                                            <label key={tick} className="flex items-center gap-2 cursor-pointer group">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedTickers.includes(tick)}
                                                    onChange={() => setSelectedTickers(prev =>
                                                        prev.includes(tick) ? prev.filter(t => t !== tick) : [...prev, tick]
                                                    )}
                                                    className={isDark ? "w-4 h-4 rounded border-gray-600 bg-gray-700 text-purple-500 focus:ring-2 focus:ring-purple-500" : "w-4 h-4 rounded border-gray-400 bg-white text-purple-600 focus:ring-2 focus:ring-purple-500"}
                                                />
                                                <span className={isDark ? "text-gray-300 text-xs group-hover:text-white transition-colors font-mono" : "text-gray-700 text-xs group-hover:text-gray-900 transition-colors font-mono"}>
                                                    {tick}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </aside>

                        {/* Main Content */}
                        <main className="lg:col-span-3 space-y-6">
                            {/* Stats Cards */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                <div className={isDark ? "bg-gradient-to-br from-green-900/30 to-green-800/30 backdrop-blur-sm border border-green-500/20 rounded-xl p-5 shadow-xl" : "bg-gradient-to-br from-green-100 to-green-200 border border-green-300 rounded-xl p-5 shadow-lg"}>
                                    <div className="flex items-center justify-between mb-2">
                                        <div className={isDark ? "text-green-400 text-sm font-medium" : "text-green-700 text-sm font-medium"}>Total P&L</div>
                                        <DollarSign className={isDark ? "w-5 h-5 text-green-400" : "w-5 h-5 text-green-700"} />
                                    </div>
                                    <div className={`text-2xl sm:text-3xl font-bold ${totalFilteredPnL >= 0 ? (isDark ? 'text-green-400' : 'text-green-700') : (isDark ? 'text-red-400' : 'text-red-600')}`}>
                                        ${totalFilteredPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </div>
                                </div>
                                <div className={isDark ? "bg-gradient-to-br from-blue-900/30 to-blue-800/30 backdrop-blur-sm border border-blue-500/20 rounded-xl p-5 shadow-xl" : "bg-gradient-to-br from-blue-100 to-blue-200 border border-blue-300 rounded-xl p-5 shadow-lg"}>
                                    <div className="flex items-center justify-between mb-2">
                                        <div className={isDark ? "text-blue-400 text-sm font-medium" : "text-blue-700 text-sm font-medium"}>Active</div>
                                        <TrendingUp className={isDark ? "w-5 h-5 text-blue-400" : "w-5 h-5 text-blue-700"} />
                                    </div>
                                    <div className={isDark ? "text-2xl sm:text-3xl font-bold text-white" : "text-2xl sm:text-3xl font-bold text-gray-900"}>
                                        {stats.activePositions}
                                    </div>
                                </div>
                                <div className={isDark ? "bg-gradient-to-br from-purple-900/30 to-purple-800/30 backdrop-blur-sm border border-purple-500/20 rounded-xl p-5 shadow-xl" : "bg-gradient-to-br from-purple-100 to-purple-200 border border-purple-300 rounded-xl p-5 shadow-lg"}>
                                    <div className="flex items-center justify-between mb-2">
                                        <div className={isDark ? "text-purple-400 text-sm font-medium" : "text-purple-700 text-sm font-medium"}>Closed</div>
                                        <BarChart3 className={isDark ? "w-5 h-5 text-purple-400" : "w-5 h-5 text-purple-700"} />
                                    </div>
                                    <div className={isDark ? "text-2xl sm:text-3xl font-bold text-white" : "text-2xl sm:text-3xl font-bold text-gray-900"}>
                                        {stats.closedPositions}
                                    </div>
                                </div>
                                <div className={isDark ? "bg-gradient-to-br from-yellow-900/30 to-yellow-800/30 backdrop-blur-sm border border-yellow-500/20 rounded-xl p-5 shadow-xl" : "bg-gradient-to-br from-yellow-100 to-yellow-200 border border-yellow-300 rounded-xl p-5 shadow-lg"}>
                                    <div className="flex items-center justify-between mb-2">
                                        <div className={isDark ? "text-yellow-400 text-sm font-medium" : "text-yellow-700 text-sm font-medium"}>Profitable</div>
                                        <TrendingUp className={isDark ? "w-5 h-5 text-yellow-400" : "w-5 h-5 text-yellow-700"} />
                                    </div>
                                    <div className={isDark ? "text-2xl sm:text-3xl font-bold text-white" : "text-2xl sm:text-3xl font-bold text-gray-900"}>
                                        {stats.profitablePositions}
                                    </div>
                                </div>
                            </div>

                            {/* Chart */}
                            <div className={isDark ? "bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-sm border border-white/10 rounded-2xl p-6 shadow-xl" : "bg-white border border-gray-300 rounded-2xl p-6 shadow-lg"}>
                                <h3 className={isDark ? "text-white text-xl font-semibold mb-4" : "text-gray-900 text-xl font-semibold mb-4"}>P&L Distribution (Top 20)</h3>
                                <div className="h-80 sm:h-96">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={chartData}>
                                            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "#374151" : "#e5e7eb"} vertical={false} />
                                            <XAxis
                                                dataKey="name"
                                                tick={{ fontSize: 11, fill: isDark ? '#9ca3af' : '#6b7280' }}
                                                angle={-45}
                                                textAnchor="end"
                                                height={80}
                                            />
                                            <YAxis tick={{ fontSize: 11, fill: isDark ? '#9ca3af' : '#6b7280' }} />
                                            <Tooltip content={<CustomTooltip />} />
                                            <ReferenceLine y={0} stroke={isDark ? "#6b7280" : "#9ca3af"} strokeWidth={2} />
                                            <Bar dataKey="P&L" fill="url(#colorGradient)" radius={[8, 8, 0, 0]} maxBarSize={60} />
                                            <defs>
                                                <linearGradient id="colorGradient" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.8} />
                                                    <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.8} />
                                                </linearGradient>
                                            </defs>
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>

                            {/* Table */}
                            <div className={isDark ? "bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-sm border border-white/10 rounded-2xl overflow-hidden shadow-xl" : "bg-white border border-gray-300 rounded-2xl overflow-hidden shadow-lg"}>
                                <div className={isDark ? "p-6 border-b border-white/10" : "p-6 border-b border-gray-200"}>
                                    <div className="flex items-center justify-between mb-4">
                                        <div>
                                            <h3 className={isDark ? "text-white text-xl font-semibold" : "text-gray-900 text-xl font-semibold"}>Position Details</h3>
                                            <p className={isDark ? "text-gray-400 text-sm mt-1" : "text-gray-600 text-sm mt-1"}>{filteredPositions.length} positions</p>
                                        </div>
                                        {activeFilterCount > 0 && (
                                            <button
                                                onClick={clearAllColumnFilters}
                                                className={isDark
                                                    ? "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 transition-colors text-xs font-medium"
                                                    : "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-100 border border-red-300 text-red-600 hover:bg-red-200 transition-colors text-xs font-medium"}
                                            >
                                                <FilterX className="w-3.5 h-3.5" />
                                                Clear {activeFilterCount} column filter{activeFilterCount > 1 ? 's' : ''}
                                            </button>
                                        )}
                                    </div>
                                    <div className="flex gap-2 flex-wrap mt-4">
                                        {(['ACTIVE', 'CLOSED', 'ALL'] as const).map(status => (
                                            <button
                                                key={status}
                                                onClick={() => setStatusFilter(status)}
                                                className={`px-4 py-2 rounded-lg font-medium transition-all text-sm ${
                                                    statusFilter === status
                                                        ? status === 'ACTIVE'
                                                            ? (isDark ? 'bg-green-500/20 text-green-400 border-2 border-green-500' : 'bg-green-200 text-green-800 border-2 border-green-500')
                                                            : status === 'CLOSED'
                                                                ? (isDark ? 'bg-purple-500/20 text-purple-400 border-2 border-purple-500' : 'bg-purple-200 text-purple-800 border-2 border-purple-500')
                                                                : (isDark ? 'bg-blue-500/20 text-blue-400 border-2 border-blue-500' : 'bg-blue-200 text-blue-800 border-2 border-blue-500')
                                                        : (isDark ? 'bg-white/5 text-gray-400 hover:bg-white/10 border-2 border-transparent' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border-2 border-transparent')
                                                }`}
                                            >
                                                {status === 'ACTIVE' ? 'Active Only' : status === 'CLOSED' ? 'Closed Only' : 'All Positions'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full">
                                        <thead>
                                        <tr className={isDark ? "bg-black/30" : "bg-gray-100"}>
                                            <th onClick={() => handleSort('ticker')} className={`text-left px-6 py-4 ${thBase}`}>
                                                <div className="flex items-center gap-1">Ticker <SortIcon colKey="ticker" /></div>
                                            </th>
                                            <th onClick={() => handleSort('account')} className={`text-left px-6 py-4 hidden sm:table-cell ${thBase}`}>
                                                <div className="flex items-center gap-1">Account <SortIcon colKey="account" /></div>
                                            </th>
                                            <th onClick={() => handleSort('alias')} className={`text-left px-6 py-4 hidden md:table-cell ${thBase}`}>
                                                <div className="flex items-center gap-1">Alias <SortIcon colKey="alias" /></div>
                                            </th>
                                            <th onClick={() => handleSort('totalShares')} className={`text-right px-6 py-4 ${thBase}`}>
                                                <div className="flex items-center justify-end gap-1">Shares <SortIcon colKey="totalShares" /></div>
                                            </th>
                                            <th onClick={() => handleSort('averageBuyPrice')} className={`text-right px-6 py-4 hidden lg:table-cell ${thBase}`}>
                                                <div className="flex items-center justify-end gap-1">Avg Buy <SortIcon colKey="averageBuyPrice" /></div>
                                            </th>
                                            <th className={isDark ? "text-center px-6 py-4 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden md:table-cell" : "text-center px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider hidden md:table-cell"}>
                                                Status
                                            </th>
                                            <th onClick={() => handleSort('realizedPnL')} className={`text-right px-6 py-4 ${thBase}`}>
                                                <div className="flex items-center justify-end gap-1">Realized <SortIcon colKey="realizedPnL" /></div>
                                            </th>
                                        </tr>
                                        <tr>
                                            <td className={`${filterRowCell} text-left`}>
                                                <ColumnFilterInput
                                                    columnKey="ticker"
                                                    columnType="string"
                                                    filter={columnFilters['ticker']}
                                                    onChange={handleColumnFilterChange}
                                                    isDark={isDark}
                                                    align="left"
                                                    placeholder="e.g. AAPL"
                                                />
                                            </td>
                                            <td className={`${filterRowCell} text-left hidden sm:table-cell`}>
                                                <ColumnFilterInput
                                                    columnKey="account"
                                                    columnType="string"
                                                    filter={columnFilters['account']}
                                                    onChange={handleColumnFilterChange}
                                                    isDark={isDark}
                                                    align="left"
                                                    placeholder="account…"
                                                />
                                            </td>
                                            <td className={`${filterRowCell} text-left hidden md:table-cell`}>
                                                <ColumnFilterInput
                                                    columnKey="alias"
                                                    columnType="string"
                                                    filter={columnFilters['alias']}
                                                    onChange={handleColumnFilterChange}
                                                    isDark={isDark}
                                                    align="left"
                                                    placeholder="alias…"
                                                />
                                            </td>
                                            <td className={`${filterRowCell} text-right`}>
                                                <ColumnFilterInput
                                                    columnKey="totalShares"
                                                    columnType="number"
                                                    filter={columnFilters['totalShares']}
                                                    onChange={handleColumnFilterChange}
                                                    isDark={isDark}
                                                    align="right"
                                                    placeholder="qty"
                                                />
                                            </td>
                                            <td className={`${filterRowCell} text-right hidden lg:table-cell`}>
                                                <ColumnFilterInput
                                                    columnKey="averageBuyPrice"
                                                    columnType="number"
                                                    filter={columnFilters['averageBuyPrice']}
                                                    onChange={handleColumnFilterChange}
                                                    isDark={isDark}
                                                    align="right"
                                                    placeholder="price"
                                                />
                                            </td>
                                            <td className={`${filterRowCell} text-center hidden md:table-cell`}>
                                                <ColumnFilterInput
                                                    columnKey="status"
                                                    columnType="string"
                                                    filter={columnFilters['status']}
                                                    onChange={handleColumnFilterChange}
                                                    isDark={isDark}
                                                    align="center"
                                                    placeholder="active…"
                                                />
                                            </td>
                                            <td className={`${filterRowCell} text-right`}>
                                                <ColumnFilterInput
                                                    columnKey="realizedPnL"
                                                    columnType="number"
                                                    filter={columnFilters['realizedPnL']}
                                                    onChange={handleColumnFilterChange}
                                                    isDark={isDark}
                                                    align="right"
                                                    placeholder="P&L"
                                                />
                                            </td>
                                        </tr>
                                        </thead>
                                        <tbody className={isDark ? "divide-y divide-white/5" : "divide-y divide-gray-200"}>
                                        {filteredPositions.map(pos => (
                                            <tr
                                                key={`${pos.account}_${pos.ticker}`}
                                                className={isDark ? "hover:bg-white/5 transition-colors" : "hover:bg-gray-50 transition-colors"}
                                            >
                                                <td className="px-6 py-4">
                                                    <div className={isDark ? "font-bold text-white text-lg" : "font-bold text-gray-900 text-lg"}>{pos.ticker}</div>
                                                </td>
                                                <td className="px-6 py-4 hidden sm:table-cell">
                                                    <div className={isDark ? "text-gray-400 font-mono text-sm" : "text-gray-600 font-mono text-sm"}>#{pos.account}</div>
                                                </td>
                                                <td className="px-6 py-4 hidden md:table-cell">
                                                    <div className={cn(
                                                        "font-medium text-sm",
                                                        isDark ? "text-blue-400" : "text-blue-600"
                                                    )}>
                                                        {accountAliases[pos.account] || '—'}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <div className={isDark ? "text-white font-mono" : "text-gray-900 font-mono"}>{pos.totalShares.toFixed(4)}</div>
                                                </td>
                                                <td className="px-6 py-4 text-right hidden lg:table-cell">
                                                    <div className={isDark ? "text-gray-300 font-mono" : "text-gray-700 font-mono"}>${pos.averageBuyPrice.toFixed(2)}</div>
                                                </td>
                                                <td className="px-6 py-4 text-center hidden md:table-cell">
                                                        <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${
                                                            pos.isClosed
                                                                ? (isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-300 text-gray-700')
                                                                : (isDark ? 'bg-green-900/50 text-green-400 border border-green-500/30' : 'bg-green-200 text-green-800 border border-green-400')
                                                        }`}>
                                                            {pos.isClosed ? 'CLOSED' : 'ACTIVE'}
                                                        </span>
                                                </td>
                                                <td className="px-6 py-4 text-right">
                                                    <div className={`font-bold text-lg font-mono ${pos.realizedPnL >= 0 ? (isDark ? 'text-green-400' : 'text-green-600') : (isDark ? 'text-red-400' : 'text-red-600')}`}>
                                                        ${pos.realizedPnL.toFixed(2)}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                        </tbody>
                                    </table>
                                    {filteredPositions.length === 0 && (
                                        <div className={isDark ? "text-center py-12 text-gray-500" : "text-center py-12 text-gray-600"}>
                                            <FilterX className="w-8 h-8 mx-auto mb-3 opacity-40" />
                                            <p>No positions match the selected filters</p>
                                            {activeFilterCount > 0 && (
                                                <button
                                                    onClick={clearAllColumnFilters}
                                                    className={isDark ? "mt-2 text-blue-400 hover:text-blue-300 text-sm underline" : "mt-2 text-blue-600 hover:text-blue-500 text-sm underline"}
                                                >
                                                    Clear column filters
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </main>
                    </div>
                )}

                {fileIndices.length === 0 && !isLoading && (
                    <label className="block text-center py-20 cursor-pointer">
                        <input
                            type="file"
                            accept=".csv"
                            multiple
                            onChange={handleMultipleFilesUpload}
                            className="hidden"
                            disabled={isLoading}
                        />
                        <div className="bg-gradient-to-br from-blue-500 to-purple-600 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 hover:scale-110 transition-transform">
                            <Upload className="w-10 h-10 text-white" />
                        </div>
                        <h2 className={isDark ? "text-2xl font-bold text-white mb-2" : "text-2xl font-bold text-gray-900 mb-2"}>Get Started</h2>
                        <p className={isDark ? "text-gray-400 max-w-md mx-auto" : "text-gray-600 max-w-md mx-auto"}>
                            Upload your Fidelity account history CSV files to analyze your portfolio performance and track P&L across all positions.
                        </p>
                    </label>
                )}
            </div>

            {/* Alias Edit Modal */}
            {editingAccount && (
                <AliasEditModal
                    account={editingAccount}
                    currentAlias={accountAliases[editingAccount] || ''}
                    suggestedAlias={computedSuggestedAliases[editingAccount] || ''}
                    onSave={(alias) => {
                        setAccountAliases(prev => ({
                            ...prev,
                            [editingAccount]: alias
                        }));
                    }}
                    onClose={() => setEditingAccount(null)}
                    isDark={isDark}
                />
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: RENDER (only runs in browser)
// ═══════════════════════════════════════════════════════════════════════════════

// Only render in browser environment (not during testing)
if (typeof document !== 'undefined') {
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <App />
        </StrictMode>
    );
}
