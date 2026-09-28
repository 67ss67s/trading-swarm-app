import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/demo/market.js',()=>({exchange:()=> 'okx'}));
vi.mock('../../src/demo/market-okx.js',()=>({loadOkxInstruments:vi.fn()}));
import { loadOkxInstruments } from '../../src/demo/market-okx.js';
import { spotWatchlist } from '../../src/demo/poll-instruments.js';
afterEach(()=>vi.resetAllMocks());
describe('观察池按 instrument 类型过滤',()=>{
 it('仅有永续的股票/商品不进入现货轮询；BTC 仍可现货观察',async()=>{
  vi.mocked(loadOkxInstruments).mockResolvedValue([{symbol:'BTCUSDT'}] as any);
  expect([...await spotWatchlist(['BTCUSDT','SKHYNIXUSDT','XAUUSDT','XAGUSDT','TSLAUSDT'])]).toEqual(['BTCUSDT']);
  expect(loadOkxInstruments).toHaveBeenCalledWith(false,'spot');
 });
 it('instrument 查询失败不会用未知符号尝试现货 ticker',async()=>{
  vi.mocked(loadOkxInstruments).mockRejectedValue(new Error('timeout'));
  await expect(spotWatchlist(['XAUUSDT'])).rejects.toThrow('timeout');
 });
});
