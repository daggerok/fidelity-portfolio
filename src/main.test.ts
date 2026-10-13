import {
    describe,
    it,
    expect
} from 'bun:test';

import {
    generateAccountAliases,
    matchesStringFilter,
    matchesNumericFilter,
    reducePortfolioOptimized,
    parseFidelityCSVOptimized,
    STRING_OPERATORS,
    NUMERIC_OPERATORS
} from './main';

import type { OptimizedFileIndex, ColumnFilter } from './main';

describe('generateAccountAliases', () => {
    it('should return empty object for empty array', () => {
        const result = generateAccountAliases([]);
        expect(result).toEqual({});
    });

    it('should extract account prefix from filename', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'History_for_Account_123456_2024.csv',
            accountPrefix: 'History_for_Account_123456',
            earliestDate: new Date('2024-01-01'),
            latestDate: new Date('2024-12-31'),
            rawData: []
        }];

        const result = generateAccountAliases(files);
        expect(result['123456']).toBeDefined();
    });

    it('should handle multiple accounts', () => {
        const files: OptimizedFileIndex[] = [
            {
                fileName: 'History_for_Account_111.csv',
                accountPrefix: 'History_for_Account_111',
                earliestDate: new Date('2024-01-01'),
                latestDate: new Date('2024-12-31'),
                rawData: []
            },
            {
                fileName: 'History_for_Account_222.csv',
                accountPrefix: 'History_for_Account_222',
                earliestDate: new Date('2024-01-01'),
                latestDate: new Date('2024-12-31'),
                rawData: []
            }
        ];

        const result = generateAccountAliases(files);
        expect(Object.keys(result)).toHaveLength(2);
        expect(result['111']).toBeDefined();
        expect(result['222']).toBeDefined();
    });

    it('should handle multiple files for same account', () => {
        const files: OptimizedFileIndex[] = [
            {
                fileName: 'History_for_Account_333_2024_Q1.csv',
                accountPrefix: 'History_for_Account_333',
                earliestDate: new Date('2024-01-01'),
                latestDate: new Date('2024-03-31'),
                rawData: []
            },
            {
                fileName: 'History_for_Account_333_2024_Q2.csv',
                accountPrefix: 'History_for_Account_333',
                earliestDate: new Date('2024-04-01'),
                latestDate: new Date('2024-06-30'),
                rawData: []
            }
        ];

        const result = generateAccountAliases(files);
        expect(result['333']).toBeDefined();
    });
});

describe('matchesStringFilter', () => {
    const createFilter = (operator: string, value: string): ColumnFilter => ({
        operator: operator as any,
        value
    });

    it('should match contains operator', () => {
        const filter = createFilter('contains', 'test');
        expect(matchesStringFilter('Testing String', filter)).toBe(true);
        expect(matchesStringFilter('Other String', filter)).toBe(false);
    });

    it('should match not_contains operator', () => {
        const filter = createFilter('not_contains', 'test');
        expect(matchesStringFilter('Other String', filter)).toBe(true);
        expect(matchesStringFilter('Testing String', filter)).toBe(false);
    });

    it('should match equals operator (case insensitive)', () => {
        const filter = createFilter('equals', 'test');
        expect(matchesStringFilter('test', filter)).toBe(true);
        expect(matchesStringFilter('Test', filter)).toBe(true);
        expect(matchesStringFilter('testing', filter)).toBe(false);
    });

    it('should match not_equals operator', () => {
        const filter = createFilter('not_equals', 'test');
        expect(matchesStringFilter('other', filter)).toBe(true);
        expect(matchesStringFilter('test', filter)).toBe(false);
    });

    it('should match starts_with operator', () => {
        const filter = createFilter('starts_with', 'tes');
        expect(matchesStringFilter('testing', filter)).toBe(true);
        expect(matchesStringFilter('Testing', filter)).toBe(true);
        expect(matchesStringFilter('atesting', filter)).toBe(false);
    });

    it('should match ends_with operator', () => {
        const filter = createFilter('ends_with', 'ing');
        expect(matchesStringFilter('testing', filter)).toBe(true);
        expect(matchesStringFilter('Testing', filter)).toBe(true);
        expect(matchesStringFilter('testings', filter)).toBe(false);
    });
});

describe('matchesNumericFilter', () => {
    const createFilter = (operator: string, value: string): ColumnFilter => ({
        operator: operator as any,
        value
    });

    it('should match eq operator with tolerance for floating point', () => {
        const filter = createFilter('eq', '100.00');
        expect(matchesNumericFilter(100, filter)).toBe(true);
        // Within tolerance (0.0001)
        expect(matchesNumericFilter(100.00005, filter)).toBe(true);
        // Outside tolerance
        expect(matchesNumericFilter(100.01, filter)).toBe(false);
        expect(matchesNumericFilter(99.99, filter)).toBe(false); // 0.01 > 0.0001
    });

    it('should match neq operator', () => {
        const filter = createFilter('neq', '100');
        expect(matchesNumericFilter(150, filter)).toBe(true);
        expect(matchesNumericFilter(100, filter)).toBe(false);
        expect(matchesNumericFilter(100.01, filter)).toBe(true);
    });

    it('should match gt operator', () => {
        const filter = createFilter('gt', '100');
        expect(matchesNumericFilter(101, filter)).toBe(true);
        expect(matchesNumericFilter(100, filter)).toBe(false);
        expect(matchesNumericFilter(99, filter)).toBe(false);
    });

    it('should match gte operator', () => {
        const filter = createFilter('gte', '100');
        expect(matchesNumericFilter(100, filter)).toBe(true);
        expect(matchesNumericFilter(101, filter)).toBe(true);
        expect(matchesNumericFilter(99, filter)).toBe(false);
    });

    it('should match lt operator', () => {
        const filter = createFilter('lt', '100');
        expect(matchesNumericFilter(99, filter)).toBe(true);
        expect(matchesNumericFilter(100, filter)).toBe(false);
        expect(matchesNumericFilter(101, filter)).toBe(false);
    });

    it('should match lte operator', () => {
        const filter = createFilter('lte', '100');
        expect(matchesNumericFilter(100, filter)).toBe(true);
        expect(matchesNumericFilter(99, filter)).toBe(true);
        expect(matchesNumericFilter(101, filter)).toBe(false);
    });

    it('should match all when value is empty', () => {
        const filter = createFilter('gt', '');
        expect(matchesNumericFilter(100, filter)).toBe(true);
        expect(matchesNumericFilter(0, filter)).toBe(true);
    });

    it('should match all when value is whitespace only', () => {
        const filter = createFilter('gte', '   ');
        expect(matchesNumericFilter(100, filter)).toBe(true);
    });

    it('should match all when value is not a valid number', () => {
        const filter = createFilter('eq', 'abc');
        expect(matchesNumericFilter(100, filter)).toBe(true);
    });

    it('should handle negative numbers', () => {
        const filter = createFilter('gte', '-50');
        expect(matchesNumericFilter(-50, filter)).toBe(true);
        expect(matchesNumericFilter(-49, filter)).toBe(true);
        expect(matchesNumericFilter(-51, filter)).toBe(false);
    });

    it('should handle zero correctly', () => {
        const filter = createFilter('eq', '0');
        expect(matchesNumericFilter(0, filter)).toBe(true);
        expect(matchesNumericFilter(0.0002, filter)).toBe(false); // outside tolerance
    });
});

describe('reducePortfolioOptimized', () => {
    it('should return empty aggregate for empty array', () => {
        const result = reducePortfolioOptimized([]);
        expect(result.positions).toEqual({});
        expect(result.globalPnL).toBe(0);
    });

    it('should aggregate buy transactions correctly', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'test.csv',
            accountPrefix: 'Account1',
            earliestDate: new Date(),
            latestDate: new Date(),
            rawData: [
                { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' },
                { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '500', 'Quantity': '5', 'Run Date': '2024-02-01' }
            ]
        }];

        const result = reducePortfolioOptimized(files);
        const positions = Object.values(result.positions);

        expect(positions).toHaveLength(1);
        expect(positions[0].ticker).toBe('AAPL');
        expect(positions[0].totalShares).toBe(15);
        expect(positions[0].totalInvested).toBe(1500);
        expect(positions[0].averageBuyPrice).toBeCloseTo(100, 2);
        expect(positions[0].isClosed).toBe(false);
    });

    it('should calculate realized P&L on sell transactions', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'test.csv',
            accountPrefix: 'Account1',
            earliestDate: new Date(),
            latestDate: new Date(),
            rawData: [
                // Fidelity exports the newest row first; the reducer walks the rows from the end (oldest first)
                { 'Action': 'YOU SOLD AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1200', 'Quantity': '5', 'Run Date': '2024-02-01' },
                { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' }
            ]
        }];

        const result = reducePortfolioOptimized(files);
        const aaplPos = result.positions['Account1_AAPL'];

        // Bought 10 shares for $1000 = $100 avg
        // Sold 5 shares at $1200 = $240 per share
        // Cost of 5 shares = 5 * $100 = $500
        // P&L = $1200 - $500 = $700
        expect(aaplPos.totalShares).toBe(5);
        expect(aaplPos.totalInvested).toBe(500);
        expect(aaplPos.realizedPnL).toBe(700);
    });

    it('should mark position as closed when all shares sold', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'test.csv',
            accountPrefix: 'Account1',
            earliestDate: new Date(),
            latestDate: new Date(),
            rawData: [
                { 'Action': 'YOU SOLD AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1500', 'Quantity': '10', 'Run Date': '2024-02-01' },
                { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' }
            ]
        }];

        const result = reducePortfolioOptimized(files);
        const aaplPos = result.positions['Account1_AAPL'];

        expect(aaplPos.isClosed).toBe(true);
        expect(aaplPos.totalShares).toBe(0);
        expect(aaplPos.realizedPnL).toBe(500);
    });

    it('should handle multiple tickers', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'test.csv',
            accountPrefix: 'Account1',
            earliestDate: new Date(),
            latestDate: new Date(),
            rawData: [
                { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' },
                { 'Action': 'YOU BOUGHT GOOGL', 'Symbol': 'GOOGL', 'Amount ($)': '3000', 'Quantity': '15', 'Run Date': '2024-01-01' }
            ]
        }];

        const result = reducePortfolioOptimized(files);
        const positions = Object.values(result.positions);

        expect(positions).toHaveLength(2);
        expect(positions.find(p => p.ticker === 'AAPL')).toBeDefined();
        expect(positions.find(p => p.ticker === 'GOOGL')).toBeDefined();
    });

    it('should handle multiple accounts separately', () => {
        const files: OptimizedFileIndex[] = [
            {
                fileName: 'test1.csv',
                accountPrefix: 'Account1',
                earliestDate: new Date(),
                latestDate: new Date(),
                rawData: [
                    { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' }
                ]
            },
            {
                fileName: 'test2.csv',
                accountPrefix: 'Account2',
                earliestDate: new Date(),
                latestDate: new Date(),
                rawData: [
                    { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '2000', 'Quantity': '20', 'Run Date': '2024-01-01' }
                ]
            }
        ];

        const result = reducePortfolioOptimized(files);

        expect(result.positions['Account1_AAPL']).toBeDefined();
        expect(result.positions['Account2_AAPL']).toBeDefined();
        expect(result.positions['Account1_AAPL'].totalShares).toBe(10);
        expect(result.positions['Account2_AAPL'].totalShares).toBe(20);
    });

    it('should ignore non-YOU actions', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'test.csv',
            accountPrefix: 'Account1',
            earliestDate: new Date(),
            latestDate: new Date(),
            rawData: [
                { 'Action': 'Dividend', 'Symbol': 'AAPL', 'Amount ($)': '10', 'Quantity': '0', 'Run Date': '2024-01-01' },
                { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-02' }
            ]
        }];

        const result = reducePortfolioOptimized(files);
        const positions = Object.values(result.positions);

        expect(positions).toHaveLength(1);
        expect(positions[0].totalShares).toBe(10);
    });

    it('should normalize ticker symbols to uppercase', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'test.csv',
            accountPrefix: 'Account1',
            earliestDate: new Date(),
            latestDate: new Date(),
            rawData: [
                { 'Action': 'YOU BOUGHT aapl', 'Symbol': 'aapl', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' }
            ]
        }];

        const result = reducePortfolioOptimized(files);
        expect(result.positions['Account1_AAPL']).toBeDefined();
    });

    it('should skip rows without Run Date during parsing', async () => {
        // the parser drops rows without a Run Date (and non-trade rows), the reducer then sees only the kept ones
        const csv = [
            'Run Date,Action,Symbol,Quantity,Amount ($)',
            '02/01/2024,YOU BOUGHT AAPL,AAPL,5,-500',
            ',YOU BOUGHT AAPL,AAPL,10,-1000',
            '01/15/2024,DIVIDEND RECEIVED AAPL,AAPL,0,12',
        ].join('\n');
        const index = await parseFidelityCSVOptimized(new File([csv], 'History_for_Account_X1.csv'));
        expect(index.rawData.length).toBe(1);
        const result = reducePortfolioOptimized([index]);
        expect(result.positions['X1_AAPL'].totalShares).toBe(5);
    });

    it('should calculate global P&L across all positions', () => {
        const files: OptimizedFileIndex[] = [{
            fileName: 'test.csv',
            accountPrefix: 'Account1',
            earliestDate: new Date(),
            latestDate: new Date(),
            rawData: [
                { 'Action': 'YOU SOLD AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1200', 'Quantity': '5', 'Run Date': '2024-02-01' },
                { 'Action': 'YOU SOLD GOOGL', 'Symbol': 'GOOGL', 'Amount ($)': '800', 'Quantity': '5', 'Run Date': '2024-02-01' },
                { 'Action': 'YOU BOUGHT AAPL', 'Symbol': 'AAPL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' },
                { 'Action': 'YOU BOUGHT GOOGL', 'Symbol': 'GOOGL', 'Amount ($)': '1000', 'Quantity': '10', 'Run Date': '2024-01-01' }
            ]
        }];

        const result = reducePortfolioOptimized(files);

        // AAPL: Buy 10 @100, Sell 5 @240, P&L = 700
        // GOOGL: Buy 10 @100, Sell 5 @160, P&L = 300
        expect(result.globalPnL).toBe(1000); // 700 + 300
    });
});

describe('Operator constants', () => {
    it('should have all string operators defined', () => {
        const expectedOps = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with'];
        expect(STRING_OPERATORS.map(o => o.value)).toEqual(expect.arrayContaining(expectedOps));
    });

    it('should have all numeric operators defined', () => {
        const expectedOps = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
        expect(NUMERIC_OPERATORS.map(o => o.value)).toEqual(expect.arrayContaining(expectedOps));
    });

    it('should have symbols for all operators', () => {
        [...STRING_OPERATORS, ...NUMERIC_OPERATORS].forEach(op => {
            expect(op.symbol).toBeTruthy();
            expect(op.label).toBeTruthy();
        });
    });
});
