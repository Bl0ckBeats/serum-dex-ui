import {
  decodeEventQueue,
  Market,
  MARKETS,
  OpenOrders,
  Orderbook,
  TOKEN_MINTS,
  TokenInstructions,
} from '@project-serum/serum';
import {PublicKey} from '@solana/web3.js';
import React, {useContext, useEffect, useState} from 'react';
import {useLocalStorageState} from './utils';
import {refreshCache, useAsyncData} from './fetch-loop';
import {useAccountData, useAccountInfo, useConnection} from './connection';
import {useWallet} from './wallet';
import tuple from 'immutable-tuple';
import {notify} from './notifications';
import {BN} from 'bn.js';
import {getTokenAccountInfo} from './tokens';
import {
  Balances,
  CustomMarketInfo,
  DeprecatedOpenOrdersBalances,
  FullMarketInfo,
  MarketContextValues,
  MarketInfo,
  OrderWithMarket,
  OrderWithMarketAndMarketName,
  SelectedTokenAccounts,
  TokenAccount,
  Trade,
} from "./types";

// Used in debugging, should be false in production
const _IGNORE_DEPRECATED = false;

const USE_MARKETS: MarketInfo[] = _IGNORE_DEPRECATED
  ? MARKETS.map((m) => ({ ...m, deprecated: false }))
  : MARKETS;

export function useMarketsList() {
  return USE_MARKETS.filter(({ deprecated }) => !deprecated);
}

export function useAllMarkets(customMarkets) {
  const connection = useConnection();
  const [markets, setMarkets] = useState<{market: Market; marketName: string; programId: PublicKey;}[]>([]);

  useEffect(() => {
    const getAllMarkets = async () => {
      const markets: {market: Market; marketName: string; programId: PublicKey;}[] = [];
      for (let marketInfo of getMarketInfos(customMarkets)) {
        try {
          const market = await Market.load(
            connection,
            marketInfo.address,
            {},
            marketInfo.programId,
          );
          markets.push({
            market,
            marketName: marketInfo.name,
            programId: marketInfo.programId,
          });
        } catch (e) {
          notify({
            message: 'Error loading all market',
            description: e.message,
            type: 'error',
          });
        }
      }
      setMarkets(markets);
    };

    getAllMarkets();
  }, [connection, customMarkets]);

  return markets;
}

export function useUnmigratedOpenOrdersAccounts() {
  const connection = useConnection();
  const { wallet } = useWallet();

  async function getUnmigratedOpenOrdersAccounts(): Promise<OpenOrders[]> {
    if (!wallet || !connection || !wallet.publicKey) {
      return [];
    }
    console.log('refreshing useUnmigratedOpenOrdersAccounts');
    let deprecatedOpenOrdersAccounts: OpenOrders[] = [];
    const deprecatedProgramIds = Array.from(
      new Set(
        USE_MARKETS.filter(
          ({ deprecated }) => deprecated,
        ).map(({ programId }) => programId.toBase58()),
      ),
    ).map((publicKeyStr) => new PublicKey(publicKeyStr));
    let programId: PublicKey;
    for (programId of deprecatedProgramIds) {
      try {
        const openOrdersAccounts = await OpenOrders.findForOwner(
          connection,
          wallet.publicKey,
          programId,
        );
        deprecatedOpenOrdersAccounts = deprecatedOpenOrdersAccounts.concat(
          openOrdersAccounts
            .filter(
              (openOrders) =>
                openOrders.baseTokenTotal.toNumber() ||
                openOrders.quoteTokenTotal.toNumber(),
            )
            .filter((openOrders) =>
              USE_MARKETS.some(
                (market) =>
                  market.deprecated && market.address.equals(openOrders.market),
              ),
            ),
        );
      } catch (e) {
        console.log(
          'Error loading deprecated markets',
          programId?.toBase58(),
          e.message,
        );
      }
    }
    // Maybe sort
    return deprecatedOpenOrdersAccounts;
  }

  const cacheKey = tuple(
    'getUnmigratedOpenOrdersAccounts',
    connection,
    wallet?.publicKey?.toBase58(),
  );
  const [accounts] = useAsyncData(getUnmigratedOpenOrdersAccounts, cacheKey, {
    refreshInterval: _VERY_SLOW_REFRESH_INTERVAL,
  });

  return {
    accounts,
    refresh: (clearCache: boolean) => refreshCache(cacheKey, clearCache),
  };
}

const MarketContext: React.Context<null | MarketContextValues> = React.createContext<null | MarketContextValues>(null);

const _VERY_SLOW_REFRESH_INTERVAL = 5000 * 1000;

// For things that don't really change
const _SLOW_REFRESH_INTERVAL = 5 * 1000;

// For things that change frequently
const _FAST_REFRESH_INTERVAL = 1000;

export const DEFAULT_MARKET = USE_MARKETS.find(
  ({ name, deprecated }) => name === 'SRM/USDT' && !deprecated,
);

function getMarketDetails(market: Market | undefined | null, customMarkets: CustomMarketInfo[]): FullMarketInfo {
  if (!market) {
    return {};
  }
  const marketInfos = getMarketInfos(customMarkets);
  const marketInfo = marketInfos.find((otherMarket) =>
    otherMarket.address.equals(market.address),
  );
  const baseCurrency =
    (market?.baseMintAddress &&
      TOKEN_MINTS.find((token) => token.address.equals(market.baseMintAddress))
        ?.name) ||
    (marketInfo?.baseLabel && `${marketInfo?.baseLabel}*`) ||
    'UNKNOWN';
  const quoteCurrency =
    (market?.quoteMintAddress &&
      TOKEN_MINTS.find((token) => token.address.equals(market.quoteMintAddress))
        ?.name) ||
    (marketInfo?.quoteLabel && `${marketInfo?.quoteLabel}*`) ||
    'UNKNOWN';

  return {
    ...marketInfo,
    marketName: marketInfo?.name,
    baseCurrency,
    quoteCurrency,
    marketInfo,
  };
}

export function MarketProvider({ children }) {
  const [marketAddress, setMarketAddress] = useLocalStorageState(
    'marketAddress',
    DEFAULT_MARKET?.address.toBase58(),
  );
  const [customMarkets, setCustomMarkets] = useLocalStorageState<CustomMarketInfo[]>(
    'customMarkets',
    [],
  );

  const address = marketAddress && new PublicKey(marketAddress);
  const connection = useConnection();
  const marketInfos = getMarketInfos(customMarkets);
  const marketInfo = address && marketInfos.find((market) =>
    market.address.equals(address),
  );

  // Replace existing market with a non-deprecated one on first load
  useEffect(() => {
    if (marketInfo && marketInfo.deprecated) {
      console.log('Switching markets from deprecated', marketInfo);
      if (DEFAULT_MARKET) {
        setMarketAddress(DEFAULT_MARKET.address.toBase58());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [market, setMarket] = useState<Market | null>();
  useEffect(() => {
    if (
      market &&
      marketInfo &&
      // @ts-ignore
      market._decoded.ownAddress?.equals(marketInfo?.address)
    ) {
      return;
    }
    setMarket(null);
    if (!marketInfo || !marketInfo.address) {
      notify({
        message: 'Error loading market',
        description: 'Please select a market from the dropdown',
        type: 'error',
      });
      return;
    }
    Market.load(connection, marketInfo.address, {}, marketInfo.programId)
      .then(setMarket)
      .catch((e) =>
        notify({
          message: 'Error loading market',
          description: e.message,
          type: 'error',
        }),
      );
    // eslint-disable-next-line
  }, [connection, marketInfo]);

  return (
    <MarketContext.Provider
      value={{
        market,
        ...getMarketDetails(market, customMarkets),
        setMarketAddress,
        customMarkets,
        setCustomMarkets,
      }}
    >
      {children}
    </MarketContext.Provider>
  );
}

export function useSelectedTokenAccounts(): [SelectedTokenAccounts, (newSelectedTokenAccounts: SelectedTokenAccounts) => void] {
  const [selectedTokenAccounts, setSelectedTokenAccounts] = useLocalStorageState<SelectedTokenAccounts>(
    'selectedTokenAccounts', {}
    );
  return [selectedTokenAccounts, setSelectedTokenAccounts]
}

export function useMarket() {
  const context = useContext(MarketContext);
  if (!context) {
    throw new Error('Missing market context')
  }
  return context
}

export function useMarkPrice() {
  const [markPrice, setMarkPrice] = useState<null | number>(null);

  const [orderbook] = useOrderbook();
  const trades = useTrades();

  useEffect(() => {
    let bb = orderbook?.bids?.length > 0 && Number(orderbook.bids[0][0]);
    let ba = orderbook?.asks?.length > 0 && Number(orderbook.asks[0][0]);
    let last = trades && trades.length > 0 && trades[0].price;

    let markPrice =
      bb && ba
        ? last
          ? [bb, ba, last].sort((a, b) => a - b)[1]
          : (bb + ba) / 2
        : null;

    setMarkPrice(markPrice);
  }, [orderbook, trades]);

  return markPrice;
}

export function _useUnfilteredTrades(limit = 10000) {
  const { market } = useMarket();
  const connection = useConnection();
  async function getUnfilteredTrades(): Promise<any[] | null> {
    if (!market || !connection) {
      return null;
    }
    return await market.loadFills(connection, limit);
  }
  const [trades] = useAsyncData(
    getUnfilteredTrades,
    tuple('getUnfilteredTrades', market, connection),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
  return trades;
  // NOTE: For now, websocket is too expensive since the event queue is large
  // and updates very frequently

  // let data = useAccountData(market && market._decoded.eventQueue);
  // if (!data) {
  //   return null;
  // }
  // const events = decodeEventQueue(data, limit);
  // return events
  //   .filter((event) => event.eventFlags.fill && event.nativeQuantityPaid.gtn(0))
  //   .map(market.parseFillEvent.bind(market));
}

export function useOrderbookAccounts() {
  const { market } = useMarket();
  // @ts-ignore
  let bidData = useAccountData(market && market._decoded.bids);
  // @ts-ignore
  let askData = useAccountData(market && market._decoded.asks);
  return {
    bidOrderbook: market && bidData ? Orderbook.decode(market, bidData) : null,
    askOrderbook: market && askData ? Orderbook.decode(market, askData) : null,
  };
}

export function useOrderbook(depth = 20): [{bids: number[][]; asks: number[][];}, boolean] {
  const { bidOrderbook, askOrderbook } = useOrderbookAccounts();
  const { market } = useMarket();
  const bids =
    !bidOrderbook || !market
      ? []
      : bidOrderbook.getL2(depth).map(([price, size]) => [price, size]);
  const asks =
    !askOrderbook || !market
      ? []
      : askOrderbook.getL2(depth).map(([price, size]) => [price, size]);
  return [{ bids, asks }, !!bids || !!asks];
}

// Want the balances table to be fast-updating, dont want open orders to flicker
// TODO: Update to use websocket
export function useOpenOrdersAccounts(fast = false) {
  const { market } = useMarket();
  const { connected, wallet } = useWallet();
  const connection = useConnection();
  async function getOpenOrdersAccounts() {
    if (!connected) {
      return null;
    }
    if (!market) {
      return null;
    }
    return await market.findOpenOrdersAccountsForOwner(
      connection,
      wallet.publicKey,
    );
  }
  return useAsyncData(
    getOpenOrdersAccounts,
    tuple('getOpenOrdersAccounts', wallet, market, connected),
    { refreshInterval: fast ? _FAST_REFRESH_INTERVAL : _SLOW_REFRESH_INTERVAL },
  );
}

export function useSelectedOpenOrdersAccount(fast = false) {
  const [accounts] = useOpenOrdersAccounts(fast);
  if (!accounts) {
    return null;
  }
  return accounts[0];
}

export function useTokenAccounts(): [TokenAccount[] | null | undefined, boolean] {
  const { connected, wallet } = useWallet();
  const connection = useConnection();
  async function getTokenAccounts() {
    if (!connected) {
      return null;
    }
    return await getTokenAccountInfo(connection, wallet.publicKey);
  }
  return useAsyncData(
    getTokenAccounts,
    tuple('getTokenAccounts', wallet, connected),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
}

export function getSelectedTokenAccountForMint(
  accounts: TokenAccount[] | undefined | null,
  mint: PublicKey | undefined,
  selectedPubKey?: string | PublicKey | null,
) {
  if (!accounts || !mint) {
    return null;
  }
  const filtered = accounts.filter(({ effectiveMint, pubkey }) =>
    mint.equals(effectiveMint) && (!selectedPubKey ||
    (typeof selectedPubKey === 'string' ? selectedPubKey : selectedPubKey.toBase58()) === pubkey.toBase58())
  );
  return filtered && filtered[0];
}

export function useSelectedQuoteCurrencyAccount() {
  const [accounts] = useTokenAccounts();
  const { market } = useMarket();
  const [selectedTokenAccounts] = useSelectedTokenAccounts();
  const mintAddress =  market?.quoteMintAddress;
  return getSelectedTokenAccountForMint(
    accounts,
    mintAddress,
    mintAddress && selectedTokenAccounts[mintAddress.toBase58()]
  );
}

export function useSelectedBaseCurrencyAccount() {
  const [accounts] = useTokenAccounts();
  const { market } = useMarket();
  const [selectedTokenAccounts] = useSelectedTokenAccounts();
  const mintAddress =  market?.baseMintAddress;
  return getSelectedTokenAccountForMint(
    accounts,
    mintAddress,
    mintAddress && selectedTokenAccounts[mintAddress.toBase58()]
  );
}

// TODO: Update to use websocket
export function useSelectedQuoteCurrencyBalances() {
  const quoteCurrencyAccount = useSelectedQuoteCurrencyAccount();
  const { market } = useMarket();
  const [accountInfo, loaded] = useAccountInfo(quoteCurrencyAccount?.pubkey);
  if (!market || !quoteCurrencyAccount || !loaded || !accountInfo) {
    return null;
  }
  if (market.quoteMintAddress.equals(TokenInstructions.WRAPPED_SOL_MINT)) {
    return accountInfo?.lamports / 1e9 ?? 0;
  }
  return market.quoteSplSizeToNumber(
    new BN(accountInfo.data.slice(64, 72), 10, 'le'),
  );
}

// TODO: Update to use websocket
export function useSelectedBaseCurrencyBalances() {
  const baseCurrencyAccount = useSelectedBaseCurrencyAccount();
  const { market } = useMarket();
  const [accountInfo, loaded] = useAccountInfo(baseCurrencyAccount?.pubkey);
  if (!market || !baseCurrencyAccount || !loaded || !accountInfo) {
    return null;
  }
  if (market.baseMintAddress.equals(TokenInstructions.WRAPPED_SOL_MINT)) {
    return accountInfo?.lamports / 1e9 ?? 0;
  }
  return market.baseSplSizeToNumber(
    new BN(accountInfo.data.slice(64, 72), 10, 'le'),
  );
}

export function useOpenOrders() {
  const { market, marketName } = useMarket();
  const openOrdersAccount = useSelectedOpenOrdersAccount();
  const { bidOrderbook, askOrderbook } = useOrderbookAccounts();
  if (!market || !openOrdersAccount || !bidOrderbook || !askOrderbook) {
    return null;
  }
  return market
    .filterForOpenOrders(bidOrderbook, askOrderbook, [openOrdersAccount])
    .map((order) => ({ ...order, marketName, market }));
}

export function useTrades(limit = 100) {
  const trades = _useUnfilteredTrades(limit);
  if (!trades) {
    return null;
  }
  // Until partial fills are each given their own fill, use maker fills
  return trades
    .filter(({ eventFlags }) => eventFlags.maker)
    .map((trade) => ({
      ...trade,
      side: trade.side === 'buy' ? 'sell' : 'buy',
    }));
}

export function useFeeDiscountKeys(): [{
  pubkey: PublicKey;
  feeTier: number;
  balance: number;
  mint: PublicKey;
}[] | null | undefined, boolean] {
  const { market } = useMarket();
  const { connected, wallet } = useWallet();
  const connection = useConnection();
  async function getFeeDiscountKeys() {
    if (!connected) {
      return null;
    }
    if (!market) {
      return null;
    }
    return await market.findFeeDiscountKeys(connection, wallet.publicKey);
  }
  return useAsyncData(
    getFeeDiscountKeys,
    tuple('getFeeDiscountKeys', wallet, market, connected),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
}

export function useFills(limit = 100) {
  const { marketName } = useMarket();
  const fills = _useUnfilteredTrades(limit);
  const [openOrdersAccounts] = useOpenOrdersAccounts();
  if (!openOrdersAccounts || openOrdersAccounts.length === 0) {
    return null;
  }
  if (!fills) {
    return null;
  }
  return fills
    .filter((fill) =>
      openOrdersAccounts.some((openOrdersAccount) =>
        fill.openOrders.equals(openOrdersAccount.publicKey),
      ),
    )
    .map((fill) => ({ ...fill, marketName }));
}

// TODO: Update to use websocket
export function useFillsForAllMarkets(limit = 100) {
  const { connected, wallet } = useWallet();

  const connection = useConnection();
  // todo: add custom markets
  const allMarkets = useAllMarkets([]);

  async function getFillsForAllMarkets() {
    let fills: Trade[] = [];
    if (!connected) {
      return fills;
    }

    let marketData;
    for (marketData of allMarkets) {
      const { market, marketName } = marketData;
      if (!market) {
        return fills;
      }
      const openOrdersAccounts = await market.findOpenOrdersAccountsForOwner(
        connection,
        wallet.publicKey,
      );
      const openOrdersAccount = openOrdersAccounts && openOrdersAccounts[0];
      if (!openOrdersAccount) {
        return fills;
      }
      const eventQueueData = await connection.getAccountInfo(
        market && market._decoded.eventQueue,
      );
      let data = eventQueueData?.data;
      if (!data) {
        return fills;
      }
      const events = decodeEventQueue(data, limit);
      const fillsForMarket: Trade[] = events
        .filter(
          (event) => event.eventFlags.fill && event.nativeQuantityPaid.gtn(0),
        )
        .map(market.parseFillEvent.bind(market));
      const ownFillsForMarket = fillsForMarket
        .filter((fill) => fill.openOrders.equals(openOrdersAccount.publicKey))
        .map((fill) => ({ ...fill, marketName }));
      fills = fills.concat(ownFillsForMarket);
    }

    console.log(JSON.stringify(fills));
    return fills;
  }

  return useAsyncData(
    getFillsForAllMarkets,
    tuple('getFillsForAllMarkets', connected, connection, allMarkets, wallet),
    { refreshInterval: _FAST_REFRESH_INTERVAL },
  );
}

// TODO: Update to use websocket
export function useOpenOrdersForAllMarkets() {
  const { connected, wallet } = useWallet();

  const connection = useConnection();
  // todo: use custom markets
  const allMarkets: {market: Market; marketName: string; programId: PublicKey;}[] = useAllMarkets([]);

  async function getOpenOrdersForAllMarkets() {
    let orders: OrderWithMarket[] = [];
    if (!connected) {
      return orders;
    }

    let marketData: {market: Market; marketName: string; programId: PublicKey;};
    for (marketData of allMarkets) {
      const { market, marketName } = marketData;
      if (!market) {
        return orders;
      }
      const openOrdersAccounts = await market.findOpenOrdersAccountsForOwner(
        connection,
        wallet.publicKey,
      );
      const openOrdersAccount = openOrdersAccounts && openOrdersAccounts[0];
      if (!openOrdersAccount) {
        return orders;
      }
      const [bids, asks] = await Promise.all([
        market.loadBids(connection),
        market.loadAsks(connection),
      ]);
      const ordersForMarket = [...bids, ...asks]
        .filter((order) => {
          return order.openOrdersAddress.equals(openOrdersAccount.publicKey);
        })
        .map((order) => {
          return { ...order, marketName };
        });
      orders = orders.concat(ordersForMarket);
    }

    return orders;
  }

  return useAsyncData(
    getOpenOrdersForAllMarkets,
    tuple(
      'getOpenOrdersForAllMarkets',
      connected,
      connection,
      wallet,
      allMarkets,
    ),
    { refreshInterval: _SLOW_REFRESH_INTERVAL },
  );
}

export function useBalances(): Balances[] {
  const baseCurrencyBalances = useSelectedBaseCurrencyBalances();
  const quoteCurrencyBalances = useSelectedQuoteCurrencyBalances();
  const openOrders = useSelectedOpenOrdersAccount(true);
  const { baseCurrency, quoteCurrency, market } = useMarket();
  const baseExists =
    openOrders && openOrders.baseTokenTotal && openOrders.baseTokenFree;
  const quoteExists =
    openOrders && openOrders.quoteTokenTotal && openOrders.quoteTokenFree;
  if (
    baseCurrency === 'UNKNOWN' ||
    quoteCurrency === 'UNKNOWN' ||
    !baseCurrency ||
    !quoteCurrency
  ) {
    return [];
  }
  return [
    {
      market,
      key: `${baseCurrency}${quoteCurrency}${baseCurrency}`,
      coin: baseCurrency,
      wallet: baseCurrencyBalances,
      orders:
        baseExists && market && openOrders
          ? market.baseSplSizeToNumber(
              openOrders.baseTokenTotal.sub(openOrders.baseTokenFree),
            )
          : null,
      openOrders,
      unsettled:
        baseExists && market && openOrders
          ? market.baseSplSizeToNumber(openOrders.baseTokenFree)
          : null,
    },
    {
      market,
      key: `${quoteCurrency}${baseCurrency}${quoteCurrency}`,
      coin: quoteCurrency,
      wallet: quoteCurrencyBalances,
      openOrders,
      orders:
        quoteExists && market && openOrders
          ? market.quoteSplSizeToNumber(
              openOrders.quoteTokenTotal.sub(openOrders.quoteTokenFree),
            )
          : null,
      unsettled:
        quoteExists && market && openOrders
          ? market.quoteSplSizeToNumber(openOrders.quoteTokenFree)
          : null,
    },
  ];
}

export function useWalletBalancesForAllMarkets() {
  return [[], true]
  // Note: This is too expensive on validators to poll. Switch over to websockets or cache accounts
  // const { connected, wallet } = useWallet();
  //
  // const connection = useConnection();
  // // todo: use custom markets
  // const allMarkets = useAllMarkets([]);
  //
  // async function getWalletBalancesForAllMarkets() {
  //   let balances: Balances[] = [];
  //   if (!connected) {
  //     return balances;
  //   }
  //
  //   let marketData: {market: Market; marketName: string; programId: PublicKey;};
  //   for (marketData of allMarkets) {
  //     const { market, marketName } = marketData;
  //     if (!market) {
  //       return balances;
  //     }
  //     const baseCurrency = marketName.includes('/') && marketName.split('/')[0];
  //     if (baseCurrency && !balances.find((balance) => balance.coin === baseCurrency)) {
  //       const baseBalance = await getCurrencyBalance(
  //         market,
  //         connection,
  //         wallet,
  //         true,
  //       );
  //       balances.push({
  //         key: baseCurrency,
  //         coin: baseCurrency,
  //         wallet: baseBalance,
  //       });
  //     }
  //     const quoteCurrency =
  //       marketName.includes('/') && marketName.split('/')[1];
  //     if (quoteCurrency && !balances.find((balance) => balance.coin === quoteCurrency)) {
  //       const quoteBalance = await getCurrencyBalance(
  //         market,
  //         connection,
  //         wallet,
  //         false,
  //       );
  //       balances.push({
  //         key: quoteCurrency,
  //         coin: quoteCurrency,
  //         wallet: quoteBalance,
  //       });
  //     }
  //   }
  //
  //   return balances;
  // }
  //
  // return useAsyncData(
  //   getWalletBalancesForAllMarkets,
  //   tuple(
  //     'getWalletBalancesForAllMarkets',
  //     connected,
  //     connection,
  //     wallet,
  //     allMarkets,
  //   ),
  //   { refreshInterval: _SLOW_REFRESH_INTERVAL },
  // );
}

// async function getCurrencyBalance(market: Market, connection, wallet, base = true) {
//   const currencyAccounts: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = base
//     ? await market.findBaseTokenAccountsForOwner(connection, wallet.publicKey)
//     : await market.findQuoteTokenAccountsForOwner(connection, wallet.publicKey);
//   const currencyAccount = currencyAccounts && currencyAccounts[0];
//   const tokenAccountBalances: RpcResponseAndContext<TokenAmount> = await connection.getTokenAccountBalance(
//     currencyAccount.pubkey,
//   );
//   return tokenAccountBalances?.value?.uiAmount;
// }

export function useOpenOrderAccountBalancesForAllMarkets() {
  return [[], true]
  // Note: This is too expensive on validators to poll. Switch over to websockets or cache accounts
  // const { connected, wallet } = useWallet();
  //
  // const connection = useConnection();
  // // todo: use custom markets
  // const allMarkets = useAllMarkets([]);
  //
  // async function getOpenOrderAccountsForAllMarkets() {
  //   let accounts: OpenOrdersBalances[] = [];
  //   if (!connected) {
  //     return accounts;
  //   }
  //
  //   let marketData: {market: Market; marketName: string; programId: PublicKey;};
  //   for (marketData of allMarkets) {
  //     const { market, marketName } = marketData;
  //     if (!market) {
  //       return accounts;
  //     }
  //     const openOrderAccounts = await market.findOpenOrdersAccountsForOwner(
  //       connection,
  //       wallet.publicKey,
  //     );
  //     if (!openOrderAccounts) {
  //       continue;
  //     }
  //     const baseCurrencyAccounts = await market.findBaseTokenAccountsForOwner(
  //       connection,
  //       wallet.publicKey,
  //     );
  //     const quoteCurrencyAccounts = await market.findQuoteTokenAccountsForOwner(
  //       connection,
  //       wallet.publicKey,
  //     );
  //
  //     const baseCurrency = marketName.includes('/') && marketName.split('/')[0];
  //     const quoteCurrency =
  //       marketName.includes('/') && marketName.split('/')[1];
  //
  //     const openOrderAccountBalances: OpenOrdersBalances[] = [];
  //     openOrderAccounts.forEach((openOrdersAccount) => {
  //       const inOrdersBase =
  //         openOrdersAccount?.baseTokenTotal &&
  //         openOrdersAccount?.baseTokenFree &&
  //         market.baseSplSizeToNumber(
  //           openOrdersAccount.baseTokenTotal.sub(
  //             openOrdersAccount.baseTokenFree,
  //           ),
  //         );
  //       const inOrdersQuote =
  //         openOrdersAccount?.quoteTokenTotal &&
  //         openOrdersAccount?.quoteTokenFree &&
  //         market.baseSplSizeToNumber(
  //           openOrdersAccount.quoteTokenTotal.sub(
  //             openOrdersAccount.quoteTokenFree,
  //           ),
  //         );
  //       const unsettledBase =
  //         openOrdersAccount?.baseTokenFree &&
  //         market.baseSplSizeToNumber(openOrdersAccount.baseTokenFree);
  //       const unsettledQuote =
  //         openOrdersAccount?.quoteTokenFree &&
  //         market.baseSplSizeToNumber(openOrdersAccount.quoteTokenFree);
  //       openOrderAccountBalances.push({
  //         market: marketName,
  //         coin: baseCurrency || '',
  //         key: baseCurrency || '',
  //         orders: inOrdersBase,
  //         unsettled: unsettledBase,
  //         openOrders: openOrdersAccount,
  //         baseCurrencyAccount: baseCurrencyAccounts && baseCurrencyAccounts[0],
  //         quoteCurrencyAccount:
  //           quoteCurrencyAccounts && quoteCurrencyAccounts[0],
  //       });
  //       openOrderAccountBalances.push({
  //         market: marketName,
  //         coin: quoteCurrency || '',
  //         key: quoteCurrency || '',
  //         orders: inOrdersQuote,
  //         unsettled: unsettledQuote,
  //         openOrders: openOrdersAccount,
  //         baseCurrencyAccount: baseCurrencyAccounts && baseCurrencyAccounts[0],
  //         quoteCurrencyAccount:
  //           quoteCurrencyAccounts && quoteCurrencyAccounts[0],
  //       });
  //     });
  //     accounts = accounts.concat(openOrderAccountBalances);
  //   }
  //
  //   return accounts;
  // }
  //
  // return useAsyncData(
  //   getOpenOrderAccountsForAllMarkets,
  //   tuple(
  //     'getOpenOrderAccountsForAllMarkets',
  //     connected,
  //     connection,
  //     wallet,
  //     allMarkets,
  //   ),
  //   { refreshInterval: _SLOW_REFRESH_INTERVAL },
  // );
}

export function useUnmigratedDeprecatedMarkets() {
  const connection = useConnection();
  const { accounts } = useUnmigratedOpenOrdersAccounts();
  const marketsList =
    accounts &&
    Array.from(new Set(accounts.map((openOrders) => openOrders.market)));
  const deps = marketsList && marketsList.map((m) => m.toBase58());

  const useUnmigratedDeprecatedMarketsInner = async () => {
    if (!marketsList) {
      return null;
    }
    const getMarket = async (address) => {
      const marketInfo = USE_MARKETS.find((market) =>
        market.address.equals(address),
      );
      if (!marketInfo) {
        console.log('Failed loading market');
        notify({
          message: 'Error loading market',
          type: 'error',
        });
        return null;
      }
      try {
        console.log('Loading market', marketInfo.name);
        // NOTE: Should this just be cached by (connection, marketInfo.address, marketInfo.programId)?
        return await Market.load(
          connection,
          marketInfo.address,
          {},
          marketInfo.programId,
        );
      } catch (e) {
        console.log('Failed loading market', marketInfo.name, e);
        notify({
          message: 'Error loading market',
          description: e.message,
          type: 'error',
        });
        return null;
      }
    };
    return (await Promise.all(marketsList.map(getMarket))).filter((x) => x);
  };
  const [markets] = useAsyncData(
    useUnmigratedDeprecatedMarketsInner,
    tuple(
      'useUnmigratedDeprecatedMarketsInner',
      connection,
      deps && deps.toString(),
    ),
    { refreshInterval: _VERY_SLOW_REFRESH_INTERVAL },
  );
  if (!markets) {
    return null;
  }
  return markets.map((market) => ({
    market,
    openOrdersList: accounts?.filter((openOrders) =>
      market && openOrders.market.equals(market.address),
    ),
  }));
}

export function useGetOpenOrdersForDeprecatedMarkets(): {
  openOrders: OrderWithMarketAndMarketName[] | null | undefined;
  loaded: boolean;
  refreshOpenOrders: () => void;
} {
  const { connected, wallet } = useWallet();
  const [customMarkets] = useLocalStorageState<CustomMarketInfo[]>('customMarkets', []);
  const connection = useConnection();
  const marketsAndOrders = useUnmigratedDeprecatedMarkets();
  const marketsList =
    marketsAndOrders && marketsAndOrders.map(({ market }) => market);

  // This isn't quite right: open order balances could change
  const deps =
    marketsList && marketsList.filter((market): market is Market => !!market).map((market) => market.address.toBase58());

  async function getOpenOrdersForDeprecatedMarkets() {
    if (!connected) {
      return null;
    }
    if (!marketsList) {
      return null;
    }
    console.log('refreshing getOpenOrdersForDeprecatedMarkets');
    const getOrders = async (market: Market | null) => {
      if (!market) {
        return null;
      }
      const { marketName } = getMarketDetails(market, customMarkets);
      try {
        console.log('Fetching open orders for', marketName);
        // Can do better than this, we have the open orders accounts already
        return (
          await market.loadOrdersForOwner(connection, wallet.publicKey)
        ).map((order) => ({ marketName, market, ...order }));
      } catch (e) {
        console.log('Failed loading open orders', market.address.toBase58(), e);
        notify({
          message: `Error loading open orders for deprecated ${marketName}`,
          description: e.message,
          type: 'error',
        });
        return null;
      }
    };
    return (await Promise.all(marketsList.map(getOrders))).filter(
        (x): x is OrderWithMarketAndMarketName[] => !!x
    ).flat();
  }

  const cacheKey = tuple(
    'getOpenOrdersForDeprecatedMarkets',
    connected,
    connection,
    wallet,
    deps && deps.toString(),
  );
  const [openOrders, loaded] = useAsyncData(
    getOpenOrdersForDeprecatedMarkets,
    cacheKey,
    {
      refreshInterval: _VERY_SLOW_REFRESH_INTERVAL,
    },
  );
  console.log('openOrders', openOrders);
  return {
    openOrders,
    loaded,
    refreshOpenOrders: () => refreshCache(cacheKey),
  };
}

export function useBalancesForDeprecatedMarkets() {
  const markets = useUnmigratedDeprecatedMarkets();
  const [customMarkets] = useLocalStorageState<CustomMarketInfo[]>('customMarkets', []);
  if (!markets) {
    return null;
  }

  const openOrderAccountBalances: DeprecatedOpenOrdersBalances[] = [];
  markets.forEach(({ market, openOrdersList }) => {
    const { baseCurrency, quoteCurrency, marketName } = getMarketDetails(
      market,
      customMarkets,
    );
    if (!baseCurrency || !quoteCurrency || !market) {
      return;
    }
    (openOrdersList || []).forEach((openOrders) => {
      const inOrdersBase =
        openOrders?.baseTokenTotal &&
        openOrders?.baseTokenFree &&
        market.baseSplSizeToNumber(
          openOrders.baseTokenTotal.sub(openOrders.baseTokenFree),
        );
      const inOrdersQuote =
        openOrders?.quoteTokenTotal &&
        openOrders?.quoteTokenFree &&
        market.baseSplSizeToNumber(
          openOrders.quoteTokenTotal.sub(openOrders.quoteTokenFree),
        );
      const unsettledBase =
        openOrders?.baseTokenFree &&
        market.baseSplSizeToNumber(openOrders.baseTokenFree);
      const unsettledQuote =
        openOrders?.quoteTokenFree &&
        market.baseSplSizeToNumber(openOrders.quoteTokenFree);

      openOrderAccountBalances.push({
        marketName,
        market,
        coin: baseCurrency,
        key: `${marketName}${baseCurrency}`,
        orders: inOrdersBase,
        unsettled: unsettledBase,
        openOrders,
      });
      openOrderAccountBalances.push({
        marketName,
        market,
        coin: quoteCurrency,
        key: `${marketName}${quoteCurrency}`,
        orders: inOrdersQuote,
        unsettled: unsettledQuote,
        openOrders,
      });
    });
  });
  return openOrderAccountBalances;
}

export function getMarketInfos(customMarkets: CustomMarketInfo[]): MarketInfo[] {
  const customMarketsInfo = customMarkets.map((m) => ({
    ...m,
    address: new PublicKey(m.address),
    programId: new PublicKey(m.programId),
    deprecated: false,
  }));

  return [...customMarketsInfo, ...USE_MARKETS];
}
