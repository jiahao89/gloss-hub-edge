import { describe, it, expect } from 'vitest';
import { parseCSV, arrayToCSV, fuzzyFindIndex } from '../csvHelper';

// ============================================================
// parseCSV 测试
// ============================================================
describe('parseCSV', () => {
  it('解析标准 CSV（含表头行）', () => {
    const csv = 'name,age,city\nAlice,30,Beijing\nBob,25,Shanghai';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['name', 'age', 'city'],
      ['Alice', '30', 'Beijing'],
      ['Bob', '25', 'Shanghai'],
    ]);
  });

  it('解析带引号字段（内含逗号）', () => {
    const csv = 'name,address\nAlice,"123 Main St, Apt 4"\nBob,"456 Elm, Suite 2"';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['name', 'address'],
      ['Alice', '123 Main St, Apt 4'],
      ['Bob', '456 Elm, Suite 2'],
    ]);
  });

  it('解析带引号字段（内含换行符）', () => {
    const csv = 'name,bio\nAlice,"Line 1\nLine 2"\nBob,"Single line"';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['name', 'bio'],
      ['Alice', 'Line 1\nLine 2'],
      ['Bob', 'Single line'],
    ]);
  });

  it('空输入返回空数组', () => {
    expect(parseCSV('')).toEqual([]);
  });

  it('单行且无换行符', () => {
    const csv = 'a,b,c';
    const result = parseCSV(csv);
    expect(result).toEqual([['a', 'b', 'c']]);
  });

  it('解析转义的双引号（"" -> "）', () => {
    const csv = 'name,quote\nAlice,"She said ""hello"""\nBob,"No quotes"';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['name', 'quote'],
      ['Alice', 'She said "hello"'],
      ['Bob', 'No quotes'],
    ]);
  });

  it('处理 UTF-8 BOM 前缀', () => {
    const csv = '\ufeffname,age\nAlice,30';
    const result = parseCSV(csv);
    // BOM 会被当作普通字符留在第一个字段中
    expect(result[0][0]).toBe('\ufeffname');
    expect(result[1]).toEqual(['Alice', '30']);
  });

  it('处理 \\r\\n 换行符', () => {
    const csv = 'a,b\r\nc,d\r\ne,f';
    const result = parseCSV(csv);
    expect(result).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });
});

// ============================================================
// fuzzyFindIndex 测试
// ============================================================
describe('fuzzyFindIndex', () => {
  it('精确匹配大小写不敏感：表头 "CN" 命中关键字 "cn"', () => {
    const headers = ['所在界面', '字号类别', 'KW', 'CN', '英文翻译'];
    expect(fuzzyFindIndex(headers, ['cn'], ['中文'])).toBe(3);
  });

  it('精确匹配忽略列名前后空白', () => {
    const headers = [' CN ', 'EN'];
    expect(fuzzyFindIndex(headers, ['cn'], [])).toBe(0);
  });

  it('精确匹配未命中时回退到模糊包含匹配', () => {
    const headers = ['所在界面', 'CN（中文）', '英文翻译'];
    expect(fuzzyFindIndex(headers, ['cn'], ['中文'])).toBe(1);
  });

  it('无任何匹配时返回 -1', () => {
    const headers = ['所在界面', '字号类别'];
    expect(fuzzyFindIndex(headers, ['cn'], ['中文', '词条'])).toBe(-1);
  });

  it('多个精确关键字按顺序优先命中', () => {
    const headers = ['en', 'cn'];
    expect(fuzzyFindIndex(headers, ['cn', 'en'], [])).toBe(1);
  });
});

// ============================================================
// arrayToCSV 测试
// ============================================================
describe('arrayToCSV', () => {
  it('正确导出表头 + 数据行', () => {
    const headers = ['name', 'age'];
    const rows = [
      ['Alice', '30'],
      ['Bob', '25'],
    ];
    const result = arrayToCSV(headers, rows);
    // 移除 BOM 后检查内容
    const content = result.replace(/^\ufeff/, '');
    expect(content).toBe('name,age\r\nAlice,30\r\nBob,25');
  });

  it('对含逗号、引号、换行的值进行转义', () => {
    const headers = ['name', 'bio'];
    const rows = [
      ['Alice', 'Has a comma, here'],
      ['Bob', 'Has "quotes"'],
      ['Charlie', 'Has\nnewline'],
    ];
    const result = arrayToCSV(headers, rows);
    const content = result.replace(/^\ufeff/, '');
    const lines = content.split('\r\n');
    // "Alice" 不含特殊字符，不加引号；"Has a comma, here" 含逗号，加引号
    expect(lines[1]).toBe('Alice,"Has a comma, here"');
    // "Bob" 不含特殊字符；"Has ""quotes""" 含引号，加引号并转义
    expect(lines[2]).toBe('Bob,"Has ""quotes"""');
    // "Charlie" 不含特殊字符；"Has\nnewline" 含换行，加引号
    expect(lines[3]).toBe('Charlie,"Has\nnewline"');
  });

  it('生成以 UTF-8 BOM 开头的字符串', () => {
    const result = arrayToCSV(['a'], [['1']]);
    expect(result.charCodeAt(0)).toBe(0xfeff);
  });

  it('null/undefined 值转为空字符串', () => {
    const headers = ['a', 'b'];
    const rows = [[null, undefined]];
    const result = arrayToCSV(headers, rows);
    const content = result.replace(/^\ufeff/, '');
    expect(content).toBe('a,b\r\n,');
  });
});
