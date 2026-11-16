#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""AB579x 系列 SDK 内存分布分析工具.

输入 (构建产物):
  map.txt   链接器内存映射: 区域定义 + 输出段/输入段/符号的位置与大小
  app.lst   反汇编列表: Sections 表 (段属性) + SYMBOL TABLE (符号精确 size)
  ram.ld    链接脚本: 只作元信息, 用于识别特殊段

输出:
  memmap_report.html   交互报告: 总览 / 内存地图 / 区域详情 / 变量索引 / 口径说明
  memmap_data.json     同一份数据的 JSON, 便于二次处理或做基线对比
  控制台摘要

用法:
  python memmap_report.py                     # 按 SDK 标准工程布局自动定位
  python memmap_report.py --map x/map.txt --lst x/app.lst --out out/
  python memmap_report.py --json-only         # 只出 JSON, 不出 HTML
"""

import argparse
import bisect
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 区域用途: 只描述"这块是什么", 所有数字都来自 map.txt
REGION_DESC = {
    'init': 'Flash 头部启动向量区, 复位入口 (前 512 字节)',
    'flash': '内部 Flash 程序区: 代码 + 只读数据 + 各 RAM 段的初值副本',
    'dnn_comm': 'CRAM 复用区: DNN/AIAEC 等算法代码 (五选一)',
    'sleep_comm': 'CRAM 复用区: 仅休眠期运行的代码与缓冲',
    'stack': '中断栈 (IRQ stack), 大小由链接脚本固定',
    'bram': 'SRAM 常驻区: 蓝牙协议栈环境等长期存活变量',
    'cram': 'SRAM 复用区: 音频/通话/音乐缓冲, 按场景互斥',
    'share': '双核/GPU 共享参数区 (固定结构体)',
    'sram': '主 SRAM: 常驻代码 + 全局变量, 通常最紧的一块',
    'gpu_ram': 'GPU 专用 SRAM: 绘制/图层缓冲 (不可放 PSRAM)',
    'lpram': '低功耗 RAM: 休眠备份 + 主线程栈 + OS 堆池',
    'aram': '音频 RAM: 编解码/通话缓冲, 多套互相复用',
    'eram': '编码 RAM: MP3 编码硬件缓冲',
    'dram': '解码 RAM: 各音频格式解码缓冲, 按格式互斥复用',
    'gram': '图形 RAM: GIF 解码缓冲',
    'jram': 'JPEG RAM: JPEG 解码缓冲',
    'psram': 'PSRAM cache 视图 0x3xxxxxxx: LVGL 代码/图片/字库/大缓冲',
    'uncache_psram': 'PSRAM uncache 视图 0x2xxxxxxx: 用户堆与用户变量',
}

# 模块归类: 顺序即优先级, 用于内存地图"谁占的"上色
MODULE_RULES = [
    (('libbtstack.a(', 'btstack'), '蓝牙协议栈'),
    (('lvgl', 'lv_'), 'LVGL'),
    (('libharfbuzz', 'libttf', 'libfulltype', 'fulltype', 'freetype'), '矢量字体'),
    (('libfribidi',), '文字排版'),
    (('libcodecs', 'libvoices'), '音频算法库'),
    (('libplatform.a(', 'platform/cmakefiles'), 'SDK 平台'),
    (('3rdparty',), '第三方库'),
    (('_obj.dir/i18n', 'i18n/', '/lang.c.'), '多语言'),
    (('/fonts/', '_obj.dir/fonts', 'font_'), '字库'),
    (('_obj.dir/functions', 'functions/', 'plugin'), '应用功能'),
    (('projects/',), '应用功能'),
    (('libc.a(', 'libgcc.a(', 'libm.a(', 'libnosys'), 'C 库/运行时'),
    (('libdrivers', 'usb_obj', 'drivers/'), '驱动'),
]

MODULE_COLOR = {
    'SDK 平台': '#4f8cff',
    '蓝牙协议栈': '#22b07d',
    'LVGL': '#f2b134',
    '矢量字体': '#e0645c',
    '文字排版': '#c08457',
    '音频算法库': '#5aa9e6',
    '应用功能': '#35b8c9',
    '多语言': '#d9a3ff',
    '字库': '#c9b24f',
    '第三方库': '#9b6cf0',
    'C 库/运行时': '#8494a8',
    '驱动': '#b07ecf',
    'RAM 段初值副本': '#8a93a5',
    '其他': '#7b8794',
}

CAT_COLOR = {
    'code': '#4f8cff',
    'rodata': '#2bb673',
    'data': '#f2b134',
    'bss': '#9b6cf0',
    'stack': '#e0645c',
    'heap': '#de5fa4',
    'buffer': '#35b8c9',
    'copy': '#8a93a5',
    'fill': '#48525f',
}
CAT_LABEL = {
    'code': '代码',
    'rodata': '只读数据',
    'data': '已初始化数据',
    'bss': '未初始化/运行时初始化',
    'stack': '栈',
    'heap': '堆',
    'buffer': '算法/绘制缓冲',
    'copy': 'RAM 段初值副本',
    'fill': '对齐填充',
}
CAT_ORDER = ['code', 'rodata', 'data', 'bss', 'stack', 'heap', 'buffer', 'copy', 'fill']

REGION_RANK = {
    'init': 0, 'flash': 1, 'stack': 2, 'bram': 3, 'cram': 4, 'share': 5, 'sram': 6,
    'dnn_comm': 7, 'sleep_comm': 8, 'gpu_ram': 9, 'lpram': 10, 'aram': 11, 'eram': 12,
    'dram': 13, 'gram': 14, 'jram': 15, 'psram': 20, 'uncache_psram': 21,
}

KIND_LABEL = {'F': '函数', 'O': '变量/缓冲', '?': '符号'}


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def read_text(path):
    """utf-8 -> gbk -> replace, 单个坏字节不至于让整份文件读不出来."""
    raw = open(path, 'rb').read()
    for enc in ('utf-8', 'gbk'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'replace')


class IntervalSet(object):
    """有序不重叠区间集合: 求区域真实占用时, 复用/重叠的段只能算一次."""

    def __init__(self):
        self.starts = []
        self.ends = []

    def _first(self, addr):
        i = bisect.bisect_left(self.starts, addr)
        while i > 0 and self.ends[i - 1] >= addr:
            i -= 1
        return i

    def add(self, start, end):
        """并入 [start, end), 返回真正新增覆盖的字节数."""
        if end <= start:
            return 0
        i = self._first(start)
        j = i
        ns, ne = start, end
        prev = 0
        while j < len(self.starts) and self.starts[j] <= ne:
            s, e = self.starts[j], self.ends[j]
            if e >= ns:
                prev += e - s
                ns = min(ns, s)
                ne = max(ne, e)
            j += 1
        del self.starts[i:j]
        del self.ends[i:j]
        self.starts.insert(i, ns)
        self.ends.insert(i, ne)
        return (ne - ns) - prev

    def union_len(self):
        return sum(e - s for s, e in zip(self.starts, self.ends))

    def cover(self, start, end):
        """[start,end) 中已被覆盖的字节数."""
        if end <= start:
            return 0
        total = 0
        j = self._first(start)
        while j < len(self.starts) and self.starts[j] < end:
            s, e = self.starts[j], self.ends[j]
            total += max(0, min(e, end) - max(s, start))
            j += 1
        return total

    def holes(self, origin, length):
        out = []
        cur, end = origin, origin + length
        for s, e in zip(self.starts, self.ends):
            if s > cur:
                out.append((cur, min(s, end)))
            cur = max(cur, e)
            if cur >= end:
                break
        if cur < end:
            out.append((cur, end))
        return [(a, b) for a, b in out if b > a]

    def gaps(self, a, b):
        """[a,b) 内尚未被覆盖的区间."""
        out = []
        cur = a
        j = self._first(a)
        while j < len(self.starts) and self.starts[j] < b:
            s, e = self.starts[j], self.ends[j]
            if s > cur:
                out.append((cur, min(s, b)))
            cur = max(cur, e)
            if cur >= b:
                break
            j += 1
        if cur < b:
            out.append((cur, b))
        return [(x, y) for x, y in out if y > x]


def union_len(intervals):
    iv = sorted((a, b) for a, b in intervals if b > a)
    if not iv:
        return 0
    total = 0
    cs, ce = iv[0]
    for a, b in iv[1:]:
        if a > ce:
            total += ce - cs
            cs, ce = a, b
        else:
            ce = max(ce, b)
    total += ce - cs
    return total


def canonical_path(path):
    """归一化链接器给出的路径, 砍掉 SDK 根前缀.

    map.txt 里同时有相对路径 (platform/CMakeFiles/...) 和带 .. 的绝对路径,
    而 SDK 根目录名可能含 "lvgl" 之类的词, 直接匹配会误判模块, 所以统一收敛到
    从 app/ platform/ projects/ 开始的相对路径.
    """
    p = os.path.normpath((path or '').replace('\\', '/')).replace('\\', '/')
    if not re.match(r'^[A-Za-z]:/', p) and not p.startswith('/'):
        return p                       # 已经是相对路径, 直接用
    parts = p.split('/')
    for i, seg in enumerate(parts):
        if i > 0 and seg in ('app', 'platform', 'projects', 'resource', 'pc_simulator'):
            return '/'.join(parts[i:])
    return '/'.join(parts[-8:])


def classify_module(path):
    low = (path or '').replace('\\', '/').lower()
    for pats, label in MODULE_RULES:
        for p in pats:
            if p in low:
                return label
    return '其他'


def basename_of(path):
    if not path:
        return '(链接脚本/未标注)'
    return re.split(r'[\\/]', path.rstrip('\\/'))[-1] or path


def section_role(name):
    """段的角色: 决定该段内字节归到哪个占用分类. 返回 None 表示按符号类型分."""
    if name in ('.stack', '.lpram_stack', '.psram_stack'):
        return 'stack'
    if name in ('.lpram_heap', '.heap', '.psram_uncache'):
        return 'heap'
    if name in ('.lv_psram', '.psram_ttf_cache', '.gpu_mem'):
        return 'buffer'
    if name in ('.alipay_disp_ram',):
        return 'buffer'
    if name in ('.share', '.got', '.got.plt', '.psram_user_data', '.psram_user_bss'):
        return 'data'
    if name == '.init':
        return 'code'
    if name.endswith('_cram') or name.endswith('_aram'):
        return 'buffer'
    if re.match(r'^\.(dram|aram|eram|gram|jram|aec)_', name):
        return 'buffer'
    return None


# ---------------------------------------------------------------------------
# map.txt 解析
# ---------------------------------------------------------------------------

RE_OUT_SEC = re.compile(
    r'^(\.\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)'
    r'(?:\s+load address\s+0x([0-9a-fA-F]+))?\s*$')
RE_HEAD_ONLY = re.compile(r'^(\.\S+)\s*$')
RE_ADDR_TAIL = re.compile(
    r'^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)'
    r'(?:\s+load address\s+0x([0-9a-fA-F]+))?\s*$')
RE_IN_SEC = re.compile(r'^ (\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(?:\s+(\S.*?))?\s*$')
RE_IN_SEC_NAME = re.compile(r'^ (\.\S+)\s*$')
RE_CONT = re.compile(r'^\s{2,}0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s*(\S.*?)?\s*$')
RE_FILL = re.compile(r'^ \*fill\*\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)')
RE_CONST = re.compile(r'^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+LONG\b')
RE_SYMBOL = re.compile(r'^\s+0x([0-9a-fA-F]+)\s+([A-Za-z_.$][^\s=]*)\s*$')
RE_WILDCARD = re.compile(r'^\s+\*?\(')


def parse_memory_config(text):
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith('Memory Configuration'):
            start = i
            break
    if start is None:
        raise RuntimeError('map.txt 里找不到 Memory Configuration 表')
    regions = []
    for ln in lines[start + 1:]:
        if ln.startswith('Linker script and memory map'):
            break
        m = re.match(r'^(\*?\w+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s*(.*)$', ln)
        if not m or m.group(1).startswith('*'):
            continue
        regions.append({
            'name': m.group(1), 'origin': int(m.group(2), 16),
            'length': int(m.group(3), 16), 'attrs': m.group(4).strip(),
        })
    if not regions:
        raise RuntimeError('Memory Configuration 表为空')
    return regions


def parse_memmap_map(text):
    """解析输出段树. 段头有三形态: 同行地址 / 名字换行 / 只有名字(空段)."""
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith('Linker script and memory map'):
            start = i + 1
            break
    if start is None:
        raise RuntimeError('map.txt 里找不到 Linker script and memory map')

    sections = []
    cur = None
    pending_sec = None
    pending_in = None
    in_secs = []
    syms = []

    def flush():
        if cur is not None:
            cur['inputs'] = in_secs
            cur['symbols'] = syms
            sections.append(cur)

    for ln in lines[start:]:
        if ln.startswith('OUTPUT(') or ln.startswith('LOAD '):
            break
        if not ln.strip():
            continue

        m = RE_OUT_SEC.match(ln)
        if m:
            flush()
            in_secs, syms = [], []
            cur = {'name': m.group(1), 'vma': int(m.group(2), 16),
                   'size': int(m.group(3), 16),
                   'lma': int(m.group(4), 16) if m.group(4) else None}
            pending_sec = None
            pending_in = None
            continue

        m = RE_HEAD_ONLY.match(ln)
        if m:
            pending_sec = m.group(1)
            pending_in = None
            continue

        # 空段: 只有名字, 下一行是输入段通配符 -> 不占地址, 直接丢弃
        if pending_sec is not None:
            m = RE_ADDR_TAIL.match(ln)
            if m:
                flush()
                in_secs, syms = [], []
                cur = {'name': pending_sec, 'vma': int(m.group(1), 16),
                       'size': int(m.group(2), 16),
                       'lma': int(m.group(3), 16) if m.group(3) else None}
                pending_sec = None
                continue
            pending_sec = None

        m = RE_IN_SEC_NAME.match(ln)
        if m:
            pending_in = m.group(1)
            continue

        if pending_in is not None:
            m = RE_CONT.match(ln)
            if m:
                in_secs.append({'sec': pending_in, 'addr': int(m.group(1), 16),
                                'size': int(m.group(2), 16),
                                'file': m.group(3) or ''})
                pending_in = None
                continue
            pending_in = None

        if RE_WILDCARD.match(ln):
            continue
        if RE_FILL.match(ln):
            continue
        m = RE_CONST.match(ln)
        if m and cur is not None:
            syms.append({'addr': int(m.group(1), 16), 'size': int(m.group(2), 16),
                         'name': '', 'const': True})
            continue
        m = RE_SYMBOL.match(ln)
        if m and cur is not None:
            syms.append({'addr': int(m.group(1), 16), 'size': 0,
                         'name': m.group(2), 'const': False})
            continue
        m = RE_IN_SEC.match(ln)
        if m and cur is not None and not ln.lstrip().startswith('*'):
            in_secs.append({'sec': m.group(1), 'addr': int(m.group(2), 16),
                            'size': int(m.group(3), 16), 'file': m.group(4) or ''})
            continue
    flush()
    return sections


# ---------------------------------------------------------------------------
# app.lst 解析
# ---------------------------------------------------------------------------

RE_LST_SEC = re.compile(
    r'^\s*(\d+)\s+(\S+)\s+([0-9a-fA-F]{8,16})\s+([0-9a-fA-F]{8,16})\s+'
    r'([0-9a-fA-F]{8,16})\s+([0-9a-fA-F]{8,16})\s+2\*\*(\d+)\s*$')
RE_LST_FLAGS = re.compile(r'^\s+([A-Z][A-Z0-9_, ]*)\s*$')
LST_FLAG_WORDS = ('CONTENTS', 'ALLOC', 'LOAD', 'READONLY', 'CODE', 'DATA',
                  'NOLOAD', 'TLS', 'EXCLUDE', 'DEBUG')


def parse_lst(text):
    """返回 (段属性表, 符号表). 符号行是定宽格式, 按 TAB 切开最稳."""
    sec_flags = {}
    syms = []
    lines = text.splitlines()

    sec_start = None
    for i, ln in enumerate(lines):
        if ln.startswith('Sections:'):
            sec_start = i + 1
            break
    if sec_start is not None:
        last = None
        for ln in lines[sec_start:]:
            if ln.startswith('SYMBOL TABLE:') or ln.startswith('Disassembly'):
                break
            m = RE_LST_SEC.match(ln)
            if m:
                last = m.group(2)
                sec_flags[last] = set()
                continue
            m = RE_LST_FLAGS.match(ln)
            if m and last:
                words = [w.strip() for w in m.group(1).split(',') if w.strip()]
                if all(w in LST_FLAG_WORDS for w in words):
                    sec_flags[last].update(words)

    sym_start = None
    for i, ln in enumerate(lines):
        if ln.startswith('SYMBOL TABLE:'):
            sym_start = i + 1
            break
    if sym_start is not None:
        for ln in lines[sym_start:]:
            if ln.startswith('Disassembly of section'):
                break
            if not ln.strip():
                continue
            if '\t' in ln:
                left, right = ln.split('\t', 1)
                right = right.strip()
            else:
                parts = ln.split()
                if len(parts) < 5:
                    continue
                left = ' '.join(parts[:-2])
                right = ' '.join(parts[-2:])
            lp = left.split()
            if len(lp) < 2:
                continue
            try:
                addr = int(lp[0], 16)
            except ValueError:
                continue
            flags = ' '.join(lp[1:-1])
            section = lp[-1]
            rp = right.split(None, 1)
            try:
                size = int(rp[0], 16) if rp else 0
            except ValueError:
                size = 0
            name = rp[1].strip() if len(rp) > 1 else ''
            hidden = False
            if name.startswith('.hidden '):
                hidden = True
                name = name[8:].strip()
            syms.append({'addr': addr, 'size': size, 'section': section,
                         'flags': flags, 'name': name, 'hidden': hidden})
    return sec_flags, syms


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------

def build_model(map_path, lst_path=None, ld_path=None):
    map_text = read_text(map_path)
    regions_raw = parse_memory_config(map_text)
    sections = parse_memmap_map(map_text)

    lst_text = read_text(lst_path) if lst_path and os.path.exists(lst_path) else None
    sec_flags, lst_syms = parse_lst(lst_text) if lst_text else ({}, [])

    sections = [s for s in sections
                if not (s['name'].startswith('.debug') or s['name'] in
                        ('.comment', '.riscv.attributes'))]
    sec_by_name = {}
    for idx, s in enumerate(sections):
        s['idx'] = idx
        sec_by_name[s['name']] = s

    for s in sections:
        flags = sec_flags.get(s['name'], set())
        s['flags'] = sorted(flags)
        if flags:
            s['noload'] = 'CONTENTS' not in flags
            s['readonly'] = 'READONLY' in flags
            s['code'] = 'CODE' in flags
        else:
            s['noload'] = s['lma'] is None and s['vma'] < 0x10000000
            s['readonly'] = False
            s['code'] = False
        s['lma_eff'] = None if s['noload'] else (s['lma'] if s['lma'] is not None else s['vma'])
        s['role'] = section_role(s['name'])

    regions = []
    for i, r in enumerate(regions_raw):
        r['idx'] = i
        r['sections'] = []
        r['desc'] = REGION_DESC.get(r['name'], '')
        regions.append(r)

    def pick_region(sec_name, addr):
        """同名区域优先, 否则取地址包含它的最小区域 (重叠区域时不串号)."""
        want = sec_name.lstrip('.')
        best = None
        for r in regions:
            if r['origin'] <= addr < r['origin'] + r['length']:
                if r['name'] == want:
                    return r
                if best is None or r['length'] < best['length']:
                    best = r
        return best

    for s in sections:
        r = pick_region(s['name'], s['vma'])
        s['region'] = r['idx'] if r else None
        if r:
            r['sections'].append(s)

    # 解析口径上的坑: 收集成 warnings, 控制台和 HTML 都显示, 不静默
    warnings = []
    unmapped = [s for s in sections if s['region'] is None and s['size'] > 0]
    if unmapped:
        warnings.append('%d 个段没有落在任何区域 (共 %s): %s, 未计入区域统计' % (
            len(unmapped), kb(sum(s['size'] for s in unmapped)),
            ', '.join(s['name'] for s in unmapped[:6])))
    noflags = [s for s in sections if not s['flags'] and s['size'] > 0]
    if noflags:
        warnings.append('%d 个段在 app.lst 里查不到 ELF 标志, NOLOAD 只能按地址推断, 相关区域大小可能偏大' %
                        len(noflags))
    if lst_syms and lst_path:
        mp = os.path.dirname(os.path.abspath(map_path))
        lp = os.path.dirname(os.path.abspath(lst_path))
        if mp.lower() != lp.lower():
            warnings.append('app.lst 与 map.txt 不在同一目录, 可能来自另一次构建: %s' % lst_path)

    # 目标文件: 路径先归一化 (砍 SDK 根前缀、消掉 ..), 否则 SDK 目录名
    # (例如 demo_sdk) 会污染模块判定
    objects = []
    obj_index = {}
    for s in sections:
        for inp in s['inputs']:
            if not inp['file']:
                continue
            rel = canonical_path(inp['file'])
            if rel not in obj_index:
                obj_index[rel] = len(objects)
                objects.append({'name': basename_of(rel), 'path': rel,
                                'module': classify_module(rel), 'size': 0})
            inp['obj'] = obj_index[rel]

    # 输入段可能被链接器放到同一地址 (SHF_MERGE 字符串池/相同常量合并):
    # 段内按地址切出不重叠的区间, 归给先出现的输入段, 否则按目标文件相加会超过段大小
    obj_size = Counter()
    for s in sections:
        painted = IntervalSet()
        exts = []
        for inp in sorted(s['inputs'], key=lambda x: (x['addr'], -x['size'])):
            if inp['size'] <= 0 or inp.get('obj') is None:
                continue
            a, b = inp['addr'], inp['addr'] + inp['size']
            for x, y in painted.gaps(a, b):
                exts.append([x, y - x, s['idx'], inp['obj']])
                obj_size[inp['obj']] += y - x
                painted.add(x, y)
        s['exts'] = exts
    for oi, sz in obj_size.items():
        objects[oi]['size'] = sz

    # 符号: 优先 app.lst (有精确 size), 否则退化成 map 符号 + 相邻地址推断
    symbols = []
    if lst_syms:
        for sy in lst_syms:
            sec = sec_by_name.get(sy['section'])
            if sec is None or not sy['name'] or sy['name'].startswith('$'):
                continue
            toks = sy['flags'].split()
            kind = 'F' if 'F' in toks else ('O' if 'O' in toks else '?')
            if sy['size'] == 0 and kind == '?' and sy['name'] == sy['section']:
                continue        # 段符号 (名字与段名相同), 不是变量/函数
            symbols.append({'addr': sy['addr'], 'size': sy['size'], 'sec': sec['idx'],
                            'kind': kind, 'name': sy['name'], 'hidden': sy['hidden']})
        # map 里还有而 lst 没列出的符号 (汇编入口等); 同段同地址已有的不再重复添加,
        # 否则 ld 的反修饰名会和 lst 的修饰名并排出现两条
        have = set((x['sec'], x['addr']) for x in symbols)
        for s in sections:
            for ms in s['symbols']:
                if ms['const'] or not ms['name'] or (s['idx'], ms['addr']) in have:
                    continue
                symbols.append({'addr': ms['addr'], 'size': ms['size'], 'sec': s['idx'],
                                'kind': '?', 'name': ms['name'], 'hidden': False})
                have.add((s['idx'], ms['addr']))
    else:
        for s in sections:
            ordered = sorted([m for m in s['symbols'] if m['name'] and not m['const']],
                             key=lambda x: x['addr'])
            end = s['vma'] + s['size']
            for i, ms in enumerate(ordered):
                nxt = ordered[i + 1]['addr'] if i + 1 < len(ordered) else end
                size = ms['size'] or max(0, min(nxt, end) - ms['addr'])
                symbols.append({'addr': ms['addr'], 'size': size, 'sec': s['idx'],
                                'kind': '?', 'name': ms['name'], 'hidden': False})

    # 符号 -> 目标文件
    starts_by_sec = {}
    inputs_by_sec = {}
    for s in sections:
        arr = sorted(s['inputs'], key=lambda x: x['addr'])
        inputs_by_sec[s['idx']] = arr
        starts_by_sec[s['idx']] = [x['addr'] for x in arr]
    for sy in symbols:
        starts = starts_by_sec.get(sy['sec'], [])
        if not starts:
            sy['obj'] = None
            continue
        i = bisect.bisect_right(starts, sy['addr']) - 1
        sy['obj'] = inputs_by_sec[sy['sec']][i]['obj'] if i >= 0 else None

    # 符号分类
    for sy in symbols:
        sec = sections[sy['sec']]
        if sec['role']:
            cat = sec['role']
        elif sy['kind'] == 'F':
            cat = 'code'
        elif sec['readonly'] and not sec['code']:
            cat = 'rodata'
        elif sec['noload']:
            cat = 'bss'
        else:
            cat = 'data'
        sy['cat'] = cat

    return {
        'regions': regions, 'sections': sections, 'objects': objects,
        'symbols': symbols, 'has_symtab': bool(lst_syms),
        'map_path': map_path, 'lst_path': lst_path, 'ld_path': ld_path,
        'warnings': warnings,
    }


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------

def section_coverage(section, syms):
    """段内符号覆盖: 结果不重叠, 重叠符号只算一次; 返回 (区间集, 填充字节数)."""
    iv = IntervalSet()
    for sy in syms:
        a = max(sy['addr'], section['vma'])
        b = min(sy['addr'] + sy['size'], section['vma'] + section['size'])
        if b > a:
            iv.add(a, b)
    return iv, max(0, section['size'] - iv.union_len())


def compute(model):
    regions = model['regions']
    sections = model['sections']
    symbols = model['symbols']

    syms_by_sec = defaultdict(list)
    for sy in symbols:
        syms_by_sec[sy['sec']].append(sy)
    for arr in syms_by_sec.values():
        arr.sort(key=lambda x: x['addr'])

    for r in regions:
        r['vma_set'] = IntervalSet()
        r['lma_set'] = IntervalSet()

    for s in sections:
        if s['region'] is not None:
            regions[s['region']]['vma_set'].add(s['vma'], s['vma'] + s['size'])
        if s['lma_eff'] is not None:
            for r in regions:
                if r['origin'] <= s['lma_eff'] < r['origin'] + r['length']:
                    r['lma_set'].add(s['lma_eff'], s['lma_eff'] + s['size'])
                    break

    # 段内复用 (overlay) 检测: 同区域内地址区间相交
    def content_end(s):
        """段内最后一个符号的结束地址: 尾部对齐填充不算"重叠"."""
        ss = syms_by_sec.get(s['idx'], [])
        return max([s['vma']] + [min(y['addr'] + y['size'], s['vma'] + s['size'])
                                for y in ss])

    def benign_overlap(grp):
        """别人只是落在前一个段的对齐填充里 (如 .psramc_data 紧贴 .psramc_text 的真实结尾)."""
        for i in range(len(grp)):
            for j in range(i + 1, len(grp)):
                if grp[j]['vma'] < grp[i]['vma'] + grp[i]['size'] \
                        and grp[j]['vma'] >= content_end(grp[i]):
                    continue
                if grp[j]['vma'] < grp[i]['vma'] + grp[i]['size']:
                    return False
        return True

    for r in regions:
        secs = sorted([s for s in r['sections'] if s['size'] > 0], key=lambda x: x['vma'])
        groups, cur, cur_end = [], [], -1
        for s in secs:
            if cur and s['vma'] < cur_end:
                cur.append(s)
                cur_end = max(cur_end, s['vma'] + s['size'])
            else:
                if cur:
                    groups.append(cur)
                cur = [s]
                cur_end = s['vma'] + s['size']
        if cur:
            groups.append(cur)
        r['groups'] = [g for g in groups if len(g) > 1 and not benign_overlap(g)]
        r['overlay_union'] = union_len(
            [(g[0]['vma'], max(x['vma'] + x['size'] for x in g)) for g in r['groups']])
        r['overlay_sum'] = sum(sum(x['size'] for x in g) for g in r['groups'])

    # 段级统计 + 分类占用
    for s in sections:
        ssyms = syms_by_sec.get(s['idx'], [])
        cov, pad = section_coverage(s, ssyms)
        s['nsym'] = len(ssyms)
        s['nvar'] = sum(1 for x in ssyms if x['kind'] != 'F')
        s['padding'] = pad
        s['content'] = s['size'] - pad
        s['coverage'] = cov
        obj_size, obj_cnt = Counter(), Counter()
        for x in s.get('exts', []):
            obj_size[x[3]] += x[1]
        for inp in s['inputs']:
            if inp.get('obj') is not None:
                obj_cnt[inp['obj']] += 1
        s['objs'] = sorted(([o, sz, obj_cnt[o]] for o, sz in obj_size.items()),
                           key=lambda x: -x[1])

    for r in regions:
        cats = Counter()
        painted = IntervalSet()
        copies = []
        # 1) 其他区域的段载入到本区域的初值副本 (Flash 里 RAM 段的初值)
        for s in sections:
            if s['lma_eff'] is None or s['region'] == r['idx']:
                continue
            if r['origin'] <= s['lma_eff'] < r['origin'] + r['length']:
                n = painted.add(s['lma_eff'], s['lma_eff'] + s['size'])
                cats['copy'] += n
                if n > 0:
                    copies.append([s['idx'], s['lma_eff'], s['size']])
        r['copies'] = copies
        # 2) 段内符号 + 段内无符号部分: 全部并入 painted, 重叠 (复用段) 只算第一次
        for s in sorted(r['sections'], key=lambda x: x['vma']):
            end = s['vma'] + s['size']
            for sy in syms_by_sec.get(s['idx'], []):
                a = max(sy['addr'], s['vma'])
                b = min(sy['addr'] + sy['size'], end)
                if b <= a:
                    continue
                new = painted.add(a, b)
                if new > 0:
                    cats[sy['cat']] += new
            gap_cat = s['role'] or 'fill'
            for a, b in painted.gaps(s['vma'], end):
                cats[gap_cat] += b - a
                painted.add(a, b)
        r['cats'] = dict(cats)
        r['copy_bytes'] = cats.get('copy', 0)
        r['vma_used'] = r['vma_set'].union_len()
        r['lma_used'] = r['lma_set'].union_len()
        r['used'] = union_len([(a, b) for a, b in zip(r['vma_set'].starts, r['vma_set'].ends)] +
                              [(a, b) for a, b in zip(r['lma_set'].starts, r['lma_set'].ends)])
        r['free'] = max(0, r['length'] - r['used'])
        r['pct'] = (r['used'] * 100.0 / r['length']) if r['length'] else 0.0
        r['content'] = max(0, r['used'] - cats.get('fill', 0) - cats.get('copy', 0))
        holes = r['vma_set'].holes(r['origin'], r['length'])
        r['largest_hole'] = max((b - a for a, b in holes), default=0)
        r['hole_count'] = len(holes)

    # 地址层面的区域重叠: 1) cache/uncache 视图别名 2) VMA 叠在一起的不同区域
    alias_groups, overlap_groups2 = [], []
    assigned = set()
    for i, a in enumerate(regions):
        if i in assigned or a['length'] < 0x100000:
            continue
        grp = [a]
        for j, b in enumerate(regions):
            if j <= i or j in assigned:
                continue
            if b['length'] == a['length'] and (a['origin'] ^ b['origin']) in (0x10000000, 0x20000000):
                grp.append(b)
                assigned.add(j)
        if len(grp) > 1:
            assigned.add(i)
            iv = IntervalSet()
            for g in grp:
                for s in g['sections']:
                    off = s['vma'] - g['origin']
                    iv.add(off, off + s['size'])
            a['alias_with'] = [g['name'] for g in grp if g is not a]
            a['alias_used'] = iv.union_len()
            alias_groups.append({'names': [g['name'] for g in grp],
                                 'length': a['length'], 'used': iv.union_len(),
                                 'kind': 'alias'})
    # VMA 重叠的不同区域 (cram / dnn_comm / sleep_comm 这类共用同一段地址)
    rest = [r for r in regions if r['idx'] not in assigned and r['sections']]
    seen = set()
    for r in rest:
        if r['idx'] in seen:
            continue
        grp = [r]
        for o in rest:
            if o['idx'] <= r['idx'] or o['idx'] in seen:
                continue
            if _ranges_intersect(r, o):
                grp.append(o)
                seen.add(o['idx'])
        if len(grp) > 1:
            seen.add(r['idx'])
            cap = union_len([(g['origin'], g['origin'] + g['length']) for g in grp])
            used_iv = IntervalSet()
            for g in grp:
                for s in g['sections']:
                    used_iv.add(s['vma'], s['vma'] + s['size'])
            overlap_groups2.append({
                'names': [g['name'] for g in grp], 'origin': min(g['origin'] for g in grp),
                'capacity': cap, 'used': used_iv.union_len(), 'kind': 'overlap'})
    # 把"共用地址"的一组区域挂到各成员上: 卡片上标一句, 免得把三行 used 相加
    for gi, g in enumerate(overlap_groups2):
        info = {'id': gi, 'names': g['names'], 'used': g['used'],
                'cap': g['capacity'], 'primary': g['names'][0]}
        for r in regions:
            if r['name'] in g['names']:
                r['grp'] = info
    model['alias_groups'] = alias_groups
    model['overlap_groups'] = overlap_groups2 + alias_groups

    model['totals'] = totals_of(regions, sections, alias_groups)
    check_app_bin(model)
    return model


def check_app_bin(model):
    """用同目录的 app.bin 体积对账: Flash 统计应等于 bin 体积减去对齐补零.

    这是最便宜的"口径自检": 段标志缺失或 map 布局异常时, Flash 会算大, 这里能兜住.
    """
    bin_path = os.path.join(os.path.dirname(os.path.abspath(model['map_path'])), 'app.bin')
    if not os.path.exists(bin_path):
        return
    size = os.path.getsize(bin_path)
    flash = model['totals']['flash']
    model['app_bin'] = size
    slack = max(4096, size // 50)          # 允许 2% 或 4KB 的对齐/零填充误差
    if abs(flash - size) > slack:
        model['warnings'].append(
            'Flash 统计 %s 与 app.bin 实际体积 %s 相差 %s, 可能有段没被正确识别 (缺 app.lst 的段标志时常见)'
            % (kb(flash), kb(size), kb(flash - size)))



def totals_of(regions, sections, alias_groups):
    """按"地址族"汇总: 同一族里按地址并集算, 别名族按偏移归一化后再并."""
    def fam_stats(pred):
        fam = [r for r in regions if pred(r)]
        alias = any(set(g['names']) & set(x['name'] for x in fam) for g in alias_groups)
        used, cap = IntervalSet(), IntervalSet()
        for r in fam:
            cap.add(0 if alias else r['origin'], (0 if alias else r['origin']) + r['length'])
            base = r['origin'] if alias else 0
            for s in r['sections']:
                used.add(s['vma'] - base, s['vma'] - base + s['size'])
        for s in sections:
            if s['lma_eff'] is None:
                continue
            for r in fam:
                if r['origin'] <= s['lma_eff'] < r['origin'] + r['length']:
                    base = r['origin'] if alias else 0
                    used.add(s['lma_eff'] - base, s['lma_eff'] - base + s['size'])
                    break
        return used.union_len(), cap.union_len()

    ram_used, ram_cap = fam_stats(lambda r: r['origin'] < 0x10000000)
    ps_used, ps_cap = fam_stats(lambda r: r['name'] in ('psram', 'uncache_psram'))
    fl_used, fl_cap = fam_stats(lambda r: r['name'] in ('flash', 'init'))
    return {
        'internal_ram': ram_used, 'ram_capacity': ram_cap,
        'psram': ps_used, 'psram_capacity': ps_cap,
        'flash': fl_used, 'flash_capacity': fl_cap,
    }



def _ranges_intersect(a, b):
    return a['origin'] < b['origin'] + b['length'] and b['origin'] < a['origin'] + a['length']


# ---------------------------------------------------------------------------
# JSON
# ---------------------------------------------------------------------------

def to_json(model):
    regions, sections, symbols, objects = (model['regions'], model['sections'],
                                           model['symbols'], model['objects'])
    rd = []
    for r in regions:
        rd.append({
            'n': r['name'], 'o': r['origin'], 'len': r['length'], 'attrs': r['attrs'],
            'desc': r['desc'], 'used': r['used'], 'vma': r['vma_used'], 'lma': r['lma_used'],
            'content': r['content'], 'free': r['free'], 'pct': round(r['pct'], 2),
            'cats': r['cats'], 'secs': [s['idx'] for s in r['sections']],
            'copies': r.get('copies', []),
            'overlays': [[s['idx'] for s in g] for g in r.get('groups', [])],
            'overlay_union': r.get('overlay_union', 0), 'overlay_sum': r.get('overlay_sum', 0),
            'alias': r.get('alias_with', []), 'alias_used': r.get('alias_used', 0),
            'grp': r.get('grp'),
            'largest_hole': r.get('largest_hole', 0), 'hole_count': r.get('hole_count', 0),
        })
    sd = []
    for s in sections:
        sd.append({
            'i': s['idx'],
            'n': s['name'], 'r': s['region'], 'v': s['vma'], 'sz': s['size'],
            'l': s['lma_eff'], 'noload': bool(s['noload']), 'role': s['role'],
            'flags': s['flags'], 'nsym': s['nsym'], 'nvar': s['nvar'],
            'pad': s['padding'], 'content': s['content'], 'objs': s['objs'],
        })
    od = [{'n': o['name'], 'p': o['path'], 'm': o['module'], 'sz': o['size']} for o in objects]
    yd = [[sy['addr'], sy['size'], sy['sec'], sy['obj'], sy['kind'], sy['name'],
           sy['cat'], 1 if sy['hidden'] else 0] for sy in symbols]
    exts = []
    for s in sections:
        exts.extend(s.get('exts', []))
    exts.sort()

    return {
        'meta': {
            'map': model['map_path'], 'lst': model['lst_path'], 'ld': model['ld_path'],
            'has_symtab': model['has_symtab'],
            'generated': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'nsym': len(symbols),
            'nvar': sum(1 for s in symbols if s['kind'] != 'F'),
            'nfunc': sum(1 for s in symbols if s['kind'] == 'F'),
            'nsect': len(sections),
            'totals': model['totals'],
            'modules': MODULE_COLOR, 'cat_color': CAT_COLOR, 'cat_label': CAT_LABEL,
            'cat_order': CAT_ORDER, 'kind_label': KIND_LABEL, 'region_rank': REGION_RANK,
            'warnings': model.get('warnings', []),
            'app_bin': model.get('app_bin'),
        },
        'regions': rd, 'sections': sd, 'objects': od, 'symbols': yd, 'extents': exts,
        'overlap_groups': model['overlap_groups'],
    }


def kb(n):
    if n >= 1024 * 1024:
        return '%.2f MB' % (n / 1048576.0)
    return '%.1f KB' % (n / 1024.0)


def rkey(r):
    return REGION_RANK.get(r['n'], 50)


def print_summary(model, data):
    meta = data['meta']
    print('工程: %s' % meta.get('project', '?'))
    print('map : %s' % model['map_path'])
    if model['lst_path']:
        print('lst : %s (%s)' % (model['lst_path'],
                                 '有符号表, 变量大小精确' if meta['has_symtab'] else '无符号表'))
    print('符号: %d (变量 %d / 函数 %d), 输出段 %d' % (
        meta['nsym'], meta['nvar'], meta['nfunc'], meta['nsect']))
    for w in model.get('warnings', []):
        print('注意: %s' % w)
    print('')
    print('%-15s %-11s %-10s %-10s %-10s %s' % ('区域', '起始', '容量', '已用', '空闲', '占用率'))
    print('-' * 68)
    for r in sorted(data['regions'], key=lambda x: (rkey(x), x['o'])):
        if not r['secs']:
            print('%-15s 0x%08x %-10s %-10s %-10s %s' % (r['n'], r['o'], kb(r['len']), '-', '-', '空'))
            continue
        print('%-15s 0x%08x %-10s %-10s %-10s %5.1f%%' % (
            r['n'], r['o'], kb(r['len']), kb(r['used']), kb(r['free']), r['pct']))
    print('-' * 68)
    t = meta['totals']
    print('内部 RAM: %s   PSRAM: %s   Flash: %s' % (
        kb(t['internal_ram']), kb(t['psram']), kb(t['flash'])))
    for g in model['overlap_groups']:
        if g['kind'] == 'alias':
            print('地址别名: %s 为同一块物理内存 -> 实际占用 %s (容量 %s)' % (
                ' / '.join(g['names']), kb(g['used']), kb(g['length'])))
        else:
            print('地址复叠: %s 共用 0x%08x 起的地址 -> 峰值 %s / 该段容量 %s' % (
                ' / '.join(g['names']), g['origin'], kb(g['used']), kb(g['capacity'])))
    print('')
    print('最大的 12 个变量/缓冲:')
    for sy in sorted([s for s in data['symbols'] if s[4] != 'F'], key=lambda x: -x[1])[:12]:
        sec = data['sections'][sy[2]]
        reg = data['regions'][sec['r']]['n'] if sec['r'] is not None else '?'
        print('  %9s  %-13s %-16s %s' % (kb(sy[1]), reg, sec['n'], sy[5]))


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

def render_html(data):
    tpl = HTML_TEMPLATE
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    title = '%s 内存分布报告' % data['meta'].get('project', 'SDK')
    return (tpl.replace('/*__TITLE__*/', title)
               .replace('/*__DATA__*/', payload))


HTML_TEMPLATE = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>/*__TITLE__*/</title>
<style>
:root{
  --bg:#0e1319;--panel:#161e28;--panel2:#1c2632;--line:#28333f;--line2:#3a4757;
  --tx:#e4ecf6;--tx2:#b3c1d1;--tx3:#93a1b2;--acc:#5b95ff;--ok:#38c483;--warn:#f5bb45;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--tx);
  font:15.5px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{padding:0 0 90px}
#page{zoom:var(--ui-scale,1)}
a{color:var(--acc);text-decoration:none}
.mono{font-family:Consolas,"Cascadia Mono",monospace}
.top{display:flex;gap:32px;align-items:flex-end;justify-content:space-between;
  padding:24px 34px 20px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#131b25,#0e1319)}
.hright{display:flex;flex-direction:column;align-items:flex-end;gap:14px}
.zoombox{display:flex;align-items:center;gap:10px;color:var(--tx3);font-size:13px}
.zoombox button{background:var(--panel);border:1px solid var(--line2);color:var(--tx2);
  border-radius:8px;padding:7px 14px;font-size:14.5px;font-family:inherit;cursor:pointer}
.zoombox button:hover{border-color:var(--acc);color:var(--tx)}
.zoombox span{min-width:52px;text-align:center;font-variant-numeric:tabular-nums}
h1{margin:0;font-size:24px;font-weight:600;letter-spacing:.3px}
h1 small{font-weight:400;color:var(--tx3);font-size:14px;margin-left:12px}
.sub{color:var(--tx3);font-size:13.5px;margin-top:8px;line-height:1.8;max-width:860px}
.sub b{color:var(--tx2);font-weight:500}
.sub div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub .pth{color:var(--tx2);font-family:Consolas,monospace;font-size:12.5px}
.kpis{display:flex;gap:14px;flex-wrap:wrap;justify-content:flex-end}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 18px;min-width:168px}
.kpi .t{color:var(--tx3);font-size:13px}
.kpi .v{font-size:20px;font-weight:600;margin-top:3px;font-variant-numeric:tabular-nums}
.kpi .u{color:var(--tx3);font-size:12.5px;font-weight:400}
nav.tabs{display:flex;gap:6px;padding:0 34px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:rgba(14,19,25,.97);backdrop-filter:blur(8px);z-index:20}
nav.tabs button{background:none;border:0;border-bottom:3px solid transparent;color:var(--tx2);
  padding:15px 20px;font-size:15.5px;cursor:pointer;font-family:inherit}
nav.tabs button:hover{color:var(--tx)}
nav.tabs button.on{color:var(--acc);border-bottom-color:var(--acc)}
main{padding:26px 34px}
.tab{display:none} .tab.on{display:block}
h2{font-size:18px;font-weight:600;margin:40px 0 16px;color:var(--tx);
  display:flex;align-items:center;gap:11px;flex-wrap:wrap}
h2::before{content:'';width:4px;height:19px;background:var(--acc);border-radius:2px}
h2:first-child{margin-top:6px}
.hint{color:var(--tx3);font-size:13.5px;font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px 18px}
.card.hot{border-color:#8d4646}
.ch{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.ch .nm{font-size:17px;font-weight:600}
.ch .cap{color:var(--tx3);font-size:13px}
.ch .pct{margin-left:auto;font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
.ch .pct.ok{color:var(--ok)} .ch .pct.warn{color:var(--warn)} .ch .pct.bad{color:#ef6f66}
.desc{color:var(--tx3);font-size:13.5px;margin:6px 0 14px;min-height:20px}
.barbox{height:26px;border-radius:5px;overflow:hidden;background:#212b36;display:flex}
.barbox>i{display:block;height:100%;transition:filter .12s}
.barbox>i:hover{filter:brightness(1.35)}
.legend{display:flex;flex-wrap:wrap;gap:7px 20px;margin-top:14px;font-size:13px;color:var(--tx2)}
.legend span{display:flex;align-items:center;gap:7px;white-space:nowrap}
.legend em{width:11px;height:11px;border-radius:2px;display:inline-block}
.legend b{font-weight:600;color:var(--tx);font-variant-numeric:tabular-nums}
.foot{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:14px;padding-top:13px;
  border-top:1px dashed var(--line);color:var(--tx3);font-size:13px}
.foot b{color:var(--tx2);font-weight:500;font-variant-numeric:tabular-nums}
.maprow{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:20px 22px;margin-bottom:20px}
.mh{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
.mh .nm{font-weight:600;font-size:17px}
.mh .info{color:var(--tx3);font-size:13.5px}
.rowlbl{color:var(--tx3);font-size:12.5px;margin:16px 0 7px;letter-spacing:.4px}
.bankrow{display:flex;align-items:center;gap:14px;margin:6px 0}
.bankrow .bl{width:310px;font-size:13px;color:var(--tx2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bankrow .bl b{color:#a8c8ff;font-weight:500;font-family:Consolas,monospace}
.bankrow .bl i{color:var(--tx3);font-style:normal;margin-left:8px;font-variant-numeric:tabular-nums}
.bankrow>div{flex:1;min-width:0}
svg.mbar{display:block;width:100%;height:30px}
svg.mbar.thin{height:20px}
svg.mbar rect{shape-rendering:crispEdges}
.lgd{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--tx2);margin-top:9px}
.lgd span{display:flex;align-items:center;gap:6px}
.lgd em{width:10px;height:10px;border-radius:2px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--line)}
th{color:var(--tx3);font-weight:500;font-size:12.5px;background:var(--panel2);
  position:sticky;top:0;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
/* 变量表: 数字/类型/区域列不许折行, 长符号名允许断行, 免得整表横向溢出 */
#vbody td:nth-child(1),#vbody td:nth-child(2),#vbody td:nth-child(4),
#vbody td:nth-child(5),#vbody td:nth-child(8){white-space:nowrap}
#vbody td:nth-child(3){overflow-wrap:anywhere}
#dmain tr.secrow td:nth-child(n+2){white-space:nowrap}
tbody tr:hover{background:#1e2937}
.tbl-wrap{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:auto;max-height:660px}
.dwrap{display:grid;grid-template-columns:226px 1fr;gap:22px;align-items:start}
.dside{position:sticky;top:64px;background:var(--panel);border:1px solid var(--line);
  border-radius:10px;padding:8px}
.dside button{display:block;width:100%;text-align:left;background:none;border:0;color:var(--tx2);
  padding:9px 12px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:14px}
.dside button:hover{background:var(--panel2);color:var(--tx)}
.dside button.on{background:#1f2f42;color:var(--acc)}
.dside button i{float:right;font-style:normal;color:var(--tx3);font-size:12.5px}
.secrow{cursor:pointer}
.secrow td:first-child{font-family:Consolas,monospace;color:#a8c8ff}
.secpanel td.mono,#tab-vars td.mono{overflow-wrap:anywhere}
.secpanel{background:#121a23;border-left:3px solid var(--acc);padding:16px 18px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.ctl{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:0 0 16px}
.ctl input,.ctl select{background:var(--panel);border:1px solid var(--line2);color:var(--tx);
  border-radius:8px;padding:9px 13px;font-size:14px;font-family:inherit;outline:none}
.ctl input{min-width:290px}
.ctl input:focus,.ctl select:focus{border-color:var(--acc)}
.chip{background:var(--panel2);border:1px solid var(--line2);color:var(--tx2);border-radius:20px;
  padding:7px 15px;font-size:13.5px;cursor:pointer;font-family:inherit}
.chip:hover{border-color:var(--acc);color:var(--tx)}
.chip.on{background:#1f2f42;border-color:var(--acc);color:var(--acc)}
.note{color:var(--tx2);font-size:14px}
.note li{margin:9px 0}
.note code{background:#1c2632;border:1px solid var(--line);border-radius:5px;padding:2px 7px;
  font-family:Consolas,monospace;font-size:13px;color:#a8c8ff}
.warnbox{background:#241c14;border:1px solid #5f4823;border-radius:10px;padding:15px 20px;
  color:#e6cf95;font-size:13.5px;margin:16px 0;line-height:1.85}
.ov g{cursor:pointer}
.tip{position:fixed;z-index:99;pointer-events:none;background:#0a0f14;border:1px solid var(--line2);
  border-radius:8px;padding:10px 14px;font-size:13px;color:var(--tx);display:none;
  max-width:520px;box-shadow:0 8px 26px rgba(0,0,0,.6);line-height:1.65}
.tip b{color:#fff} .tip .m{color:var(--tx3)}
.big{font-size:26px;font-weight:600;letter-spacing:.5px}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.small{color:var(--tx3);font-size:12.5px}
.pill{display:inline-block;background:#1f2f42;border:1px solid #33506f;color:#a8c8ff;
  border-radius:5px;padding:2px 9px;font-size:12px;margin-left:8px}
</style>
</head>
<body>
<div id="page">
<header class="top">
  <div>
    <h1>/*__TITLE__*/</h1>
    <div class="sub" id="src"></div>
  </div>
  <div class="hright">
    <div class="zoombox">
      <button id="zout" title="字小一点">A-</button>
      <span id="zval">100%</span>
      <button id="zin" title="字大一点">A+</button>
    </div>
    <div class="kpis" id="kpis"></div>
  </div>
</header>
<nav class="tabs" id="tabs">
  <button data-tab="overview" class="on">总览</button>
  <button data-tab="map">内存地图</button>
  <button data-tab="detail">区域详情</button>
  <button data-tab="vars">变量索引</button>
  <button data-tab="notes">口径说明</button>
</nav>
<main>
  <section id="tab-overview" class="tab on"></section>
  <section id="tab-map" class="tab"></section>
  <section id="tab-detail" class="tab"></section>
  <section id="tab-vars" class="tab"></section>
  <section id="tab-notes" class="tab"></section>
</main>
</div>
<div class="tip" id="tip"></div>
<script>
const DATA = /*__DATA__*/;
const M = DATA.meta, R = DATA.regions, S = DATA.sections, O = DATA.objects,
      Y = DATA.symbols, X = DATA.extents;
const byId = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function fmt(n){
  if(n===null||n===undefined) return '-';
  if(n<1024) return n+' B';
  if(n<1048576) return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(2)+' MB';
}
const hx = (n,w) => '0x'+n.toString(16).padStart(w||8,'0');
const pct = (a,b) => b ? (a*100/b) : 0;
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const regName = r => (r.r===null||r.r===undefined) ? '未映射' : R[r.r].n;
const secSize = i => S[i].sz;
const catColor = c => (M.cat_color[c]||'#555');
const catLabel = c => (M.cat_label[c]||c);

/* ---------------- tooltip ---------------- */
const tip = byId('tip');
function showTip(e, html){
  tip.innerHTML = html; tip.style.display='block';
  const pad=14, w=tip.offsetWidth, h=tip.offsetHeight;
  let x=e.clientX+pad, y=e.clientY+pad;
  if(x+w>innerWidth-8) x=e.clientX-w-pad;
  if(y+h>innerHeight-8) y=e.clientY-h-pad;
  tip.style.left=x+'px'; tip.style.top=y+'px';
}
function hideTip(){ tip.style.display='none'; }

/* ---------------- bars ---------------- */
/* items: [{s,e,c,tip,label}] 按区域地址轴画, 宽度归一化到 1000 */
function drawBar(items, total, axisStart, cls){
  const NS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(NS,'svg');
  svg.setAttribute('class','mbar'+(cls?' '+cls:''));
  svg.setAttribute('viewBox','0 0 1000 100');
  svg.setAttribute('preserveAspectRatio','none');
  const g=document.createElementNS(NS,'g');
  for(const it of items){
    const a=clamp((it.s-axisStart)/total*1000,0,1000);
    const b=clamp((it.e-axisStart)/total*1000,0,1000);
    const r=document.createElementNS(NS,'rect');
    r.setAttribute('x',a.toFixed(2));
    r.setAttribute('y',0);
    r.setAttribute('width',Math.max(0.35,b-a).toFixed(2));
    r.setAttribute('height',100);
    r.setAttribute('fill',it.c);
    if(it.tip){
      r.addEventListener('mousemove',ev=>showTip(ev,it.tip));
      r.addEventListener('mouseleave',hideTip);
    }
    g.appendChild(r);
  }
  svg.appendChild(g);
  return svg;
}
function barOf(width, items, total, axisStart, cls){
  const wrap=document.createElement('div');
  wrap.className='barbox';
  const svg=drawBar(items,total,axisStart,cls);
  svg.style.width='100%'; svg.style.height='100%';
  wrap.appendChild(svg);
  return wrap;
}
function legend(entries){
  const d=document.createElement('div'); d.className='legend';
  d.innerHTML=entries.map(x=>`<span><em style="background:${x.c}"></em>${esc(x.l)} <b>${fmt(x.v)}</b></span>`).join('');
  return d;
}

/* ---------------- KPI ---------------- */
function renderKpis(){
  const t=M.totals;
  const ramPct=pct(t.internal_ram,t.ram_capacity);
  const items=[
    ['内部 RAM', fmt(t.internal_ram), ramPct.toFixed(1)+'% / '+fmt(t.ram_capacity), ramPct],
    ['PSRAM', fmt(t.psram), pct(t.psram,t.psram_capacity).toFixed(1)+'% / '+fmt(t.psram_capacity), pct(t.psram,t.psram_capacity)],
    ['Flash', fmt(t.flash), pct(t.flash,t.flash_capacity).toFixed(1)+'% / '+fmt(t.flash_capacity), pct(t.flash,t.flash_capacity)],
    ['变量/缓冲', M.nvar, '共 '+M.nsym+' 个符号', -1],
  ];
  byId('kpis').innerHTML=items.map(([n,v,u,p])=>{
    const cl = p<0 ? 'var(--tx)' : (p>90?'#e0645c':(p>75?'var(--warn)':'var(--ok)'));
    return `<div class="kpi"><div class="t">${n}</div><div class="v" style="color:${cl}">${v}<span class="u"> ${u}</span></div></div>`;
  }).join('');
}

/* ---------------- 总览 ---------------- */
function catItems(r){
  const out=[];
  for(const c of M.cat_order){
    const v=(r.cats||{})[c]||0;
    if(v>0) out.push({c:catColor(c), l:catLabel(c), v});
  }
  return out;
}
function renderOverview(){
  const host=byId('tab-overview');
  host.innerHTML='';
  const h=document.createElement('h2');
  h.innerHTML='地址空间总览 <span class="hint">每个块按"容量"等比, 条内为该区域的占用构成; 点开"内存地图"看逐字节分布</span>';
  host.appendChild(h);

  if(DATA.overlap_groups.length){
    const box=document.createElement('div'); box.className='warnbox';
    box.innerHTML='<b>地址复用提示</b> ' + DATA.overlap_groups.map(g=>{
      const names=g.names.map(n=>'<span class="pill">'+n+'</span>').join(' ');
      const txt = g.kind==='alias'
        ? `是同一块物理内存的不同视图, 合并后实际占用 <b>${fmt(g.used)}</b> / ${fmt(g.length)}`
        : `共用 ${hx(g.origin)} 起的同一段地址, 该地址段峰值 <b>${fmt(g.used)}</b> / ${fmt(g.capacity)}`;
      return `<span style="white-space:nowrap;display:inline-block;margin:5px 20px 5px 0">${names} ${txt};</span>`;
    }).join('');
    host.appendChild(box);
  }

  const hot=DATA.regions.filter(r=>r.secs.length&&r.pct>=90&&r.n!=='init'&&r.n!=='stack')
    .sort((a,b)=>b.pct-a.pct);
  if(hot.length){
    const box=document.createElement('div'); box.className='warnbox';
    box.innerHTML='<b>接近上限的区域</b> ' + hot.map(r=>
      `<span style="white-space:nowrap;display:inline-block;margin:5px 20px 5px 0">
        <span class="pill">${r.n} ${r.pct.toFixed(1)}%</span> 已用 ${fmt(r.used)}, 剩余 ${fmt(r.free)}</span>`).join('');
    host.appendChild(box);
  }

  const grid=document.createElement('div'); grid.className='cards';
  const list=[...DATA.regions].sort((a,b)=>((M.region_rank[a.n]??50)-(M.region_rank[b.n]??50))||(a.o-b.o));
  for(const r of list){
    if(!r.secs.length) continue;
    const card=document.createElement('div');
    card.className='card'+(r.pct>92?' hot':'');
    const cl=r.pct>92?'bad':(r.pct>80?'warn':'ok');
    card.innerHTML=`<div class="ch"><span class="nm">${r.n}</span>
      <span class="cap mono">${hx(r.o)} · ${fmt(r.len)}</span>
      <span class="pct ${cl}">${r.pct.toFixed(1)}%</span></div>
      <div class="desc">${esc(r.desc||'')}</div>`;
    // 分类条
    const items=[];
    let acc=r.o;
    for(const c of M.cat_order){
      const v=(r.cats||{})[c]||0;
      if(v>0){ items.push({s:acc,e:acc+v,c:catColor(c),
        tip:`<b>${catLabel(c)}</b><br>${fmt(v)} (${pct(v,r.len).toFixed(1)}%)`}); acc+=v; }
    }
    if(r.free>0){ items.push({s:acc,e:acc+r.free,c:'#212b36',
      tip:`<b>空闲/未分配</b><br>${fmt(r.free)} (${pct(r.free,r.len).toFixed(1)}%)`}); }
    card.appendChild(barOf(0,items,r.len,r.o));
    card.appendChild(legend(catItems(r).map(x=>({...x}))));
    const foot=document.createElement('div'); foot.className='foot';
    let f=[];
    f.push(`已用 <b>${fmt(r.used)}</b>`);
    f.push(`空闲 <b>${fmt(r.free)}</b>`);
    if(r.free>0) f.push(`最大空洞 <b>${fmt(r.largest_hole)}</b>`);
    if(r.content) f.push(`符号实测 <b>${fmt(r.content)}</b>`);
    if(r.overlays.length) f.push(`复用段 <b>${r.overlays.length}</b> 组`);
    if(r.grp && r.grp.names.length>1)
      f.push(`与 <b style="color:#e6cf95">${r.grp.names.filter(n=>n!==r.n).join('/')}</b> 共用地址 (峰值 ${fmt(r.grp.used)})`);
    if(r.alias.length) f.push(`别名 <b>${r.alias.join('/')}</b>`);
    if(r.lma && r.lma!==r.used) f.push(`其中 Flash 副本 <b>${fmt(r.lma)}</b>`);
    f.push(`共 <b>${r.secs.length}</b> 段`);
    foot.innerHTML=f.join('');
    card.appendChild(foot);
    grid.appendChild(card);
  }
  host.appendChild(grid);
  host.appendChild(shareBars());
  host.appendChild(topTargets());
}

/* 三类存储的占用构成: 谁把这块吃掉了 */
function shareBars(){
  const box=document.createElement('div');
  const h=document.createElement('h2');
  h.innerHTML='占用构成 <span class="hint">同一块存储里, 各区域各占多少; 灰条是没用到的部分</span>';
  box.appendChild(h);
  const fams=[
    {t:'内部 RAM', sel:r=>r.o<0x10000000, used:M.totals.internal_ram, cap:M.totals.ram_capacity},
    {t:'PSRAM', sel:r=>r.n==='psram'||r.n==='uncache_psram', used:M.totals.psram, cap:M.totals.psram_capacity},
    {t:'Flash', sel:r=>r.n==='init'||r.n==='flash', used:M.totals.flash, cap:M.totals.flash_capacity},
  ];
  const cols=['#4f8cff','#22b07d','#f2b134','#e0645c','#9b6cf0','#35b8c9','#de5fa4','#c9b24f',
              '#d9a3ff','#7b8794','#5aa9e6','#c08457'];
  for(const f of fams){
    const all=DATA.regions.filter(f.sel).filter(r=>r.used>0).sort((a,b)=>b.used-a.used);
    if(!all.length) continue;
    // 共用地址的几个区域只算一次 (取该地址段的峰值), 否则内部 RAM 会重复计数
    const seenGrp=new Set(); const rs=[];
    for(const r of all){
      if(r.grp){
        if(seenGrp.has(r.grp.id)) continue;
        seenGrp.add(r.grp.id);
        rs.push({n:r.grp.names.join('/'), used:r.grp.used, grp:r.grp});
      } else rs.push({n:r.n, used:r.used, r:r});
    }
    rs.sort((a,b)=>b.used-a.used);
    const row=document.createElement('div'); row.className='maprow';
    const sum=rs.reduce((a,r)=>a+r.used,0);
    const total=Math.max(f.cap,sum,f.used);
    row.innerHTML=`<div class="mh"><span class="nm">${f.t}</span>
      <span class="info">已用 ${fmt(f.used)} / ${fmt(f.cap)} · ${pct(f.used,f.cap).toFixed(1)}%</span></div>`;
    const items=[]; let acc=0; const lg=[];
    rs.forEach((r,i)=>{
      const c=cols[i%cols.length];
      const tip = r.grp
        ? `<b>${r.n}</b> (共用同一段地址)<br>该地址段峰值 ${fmt(r.grp.used)} / 容量 ${fmt(r.grp.cap)}`
        : `<b>${r.n}</b> ${esc(r.r.desc||'')}<br>已用 ${fmt(r.used)} (${pct(r.used,f.cap).toFixed(1)}% of ${f.t})<br>
           容量 ${fmt(r.r.len)} · 占用率 ${r.r.pct.toFixed(1)}%`;
      items.push({s:acc,e:acc+r.used,c:c,tip:tip});
      lg.push(`<span><em style="background:${c}"></em>${r.n} <b>${fmt(r.used)}</b></span>`);
      acc+=r.used;
    });
    if(acc<total) items.push({s:acc,e:total,c:'#212b36',
      tip:`<b>未使用</b><br>${fmt(total-acc)}`});
    row.appendChild(barOf(0,items,total,0));
    const l=document.createElement('div'); l.className='lgd'; l.innerHTML=lg.join('');
    row.appendChild(l);
    box.appendChild(row);
  }
  return box;
}

/* 内部 RAM / PSRAM 里最费空间的目标文件 */
function topTargets(){
  const box=document.createElement('div');
  const h=document.createElement('h2');
  h.innerHTML='RAM 消耗 Top 15 目标文件 <span class="hint">按输入段累计 (含 .comm/.bss/.bram 等常驻段), 不含 Flash 代码</span>';
  box.appendChild(h);
  const famReg=new Set();
  DATA.regions.forEach((r,i)=>{ if(r.o<0x10000000||r.n==='psram'||r.n==='uncache_psram') famReg.add(i); });
  const agg={};
  for(const x of X){
    const s=S[x[2]];
    if(s.r===null||!famReg.has(s.r)) continue;
    const r=DATA.regions[s.r];
    const key=r.n+'|'+x[3];
    if(!agg[key]) agg[key]={reg:r.n,obj:x[3],sz:0};
    agg[key].sz+=x[1];
  }
  const rows=Object.values(agg).sort((a,b)=>b.sz-a.sz).slice(0,15);
  if(!rows.length) return box;
  const mx=rows[0].sz;
  const wrap=document.createElement('div'); wrap.className='tbl-wrap'; wrap.style.maxHeight='none';
  wrap.innerHTML='<table><tbody>'+rows.map(x=>{
    const o=O[x.obj]||{n:'?',m:'其他',p:''};
    return `<tr><td class="mono" style="width:290px" title="${esc(o.p)}">${esc(o.n)}</td>
      <td class="small" style="width:92px">${o.m}</td>
      <td class="n" style="width:82px">${fmt(x.sz)}</td>
      <td style="width:170px"><div style="height:9px;background:#212b36;border-radius:3px">
        <div style="height:9px;width:${(x.sz/mx*100).toFixed(1)}%;background:${M.modules[o.m]||'#7b8794'};border-radius:3px"></div></div></td>
      <td class="small">${x.reg}</td></tr>`;
  }).join('')+'</tbody></table>';
  box.appendChild(wrap);
  return box;
}

/* ---------------- 内存地图 ---------------- */
/* 其他区域段在本区域里的初值副本 (Flash 里 .comm/.bss 的初值) */
function copyItems(r){
  return (r.copies||[]).map(([si,lma,sz])=>({
    s:lma,e:lma+sz,c:'#8a93a5',
    tip:`<b>${S[si].n} 的初值副本</b><br>${hx(lma)} - ${hx(lma+sz)}<br>${fmt(sz)} · 上电时由 boot 拷到 RAM`}));
}
function mergeByModule(r){
  /* 把区域内的输入段按模块合并成连续块 */
  const segs=[];
  for(const si of r.secs){
    for(const x of X){
      if(x[2]!==si) continue;
      const mod=O[x[3]]? O[x[3]].m : '其他';
      segs.push({a:x[0],b:x[0]+x[1],m:mod});
    }
  }
  for(const [si,lma,sz] of (r.copies||[])) segs.push({a:lma,b:lma+sz,m:'RAM 段初值副本'});
  segs.sort((p,q)=>p.a-q.a);
  const out=[];
  for(const s of segs){
    const last=out[out.length-1];
    if(last && last.m===s.m && s.a<=last.e){ last.e=Math.max(last.e,s.b); }
    else out.push({s:s.a,e:s.b,m:s.m});
  }
  return out;
}
function moduleItems(r){
  const segs=mergeByModule(r);
  return segs.map(s=>({s:s.s,e:s.e,c:M.modules[s.m]||'#8a93a5',
    tip:`<b>${s.m}</b><br>${hx(s.s)} - ${hx(s.e)}<br>${fmt(s.e-s.s)} (${pct(s.e-s.s,r.len).toFixed(2)}%)`}));
}
function objectItems(r){
  const per=[];
  for(const si of r.secs){
    for(const x of X){
      if(x[2]!==si) continue;
      per.push({s:x[0],e:x[0]+x[1],o:x[3],m:O[x[3]]?O[x[3]].m:'其他'});
    }
  }
  for(const [si,lma,sz] of (r.copies||[])) per.push({s:lma,e:lma+sz,o:-1,m:'RAM 段初值副本',sec:si});
  per.sort((p,q)=>p.s-q.s);
  const big=[...per].filter(x=>x.o>=0).sort((a,b)=>(b.e-b.s)-(a.e-a.s));
  const keep=new Set(big.slice(0,26).map(x=>x.o+'_'+x.s));
  return per.map(x=>{
    if(x.o<0) return {s:x.s,e:x.e,c:'#8a93a5',
      tip:`<b>${S[x.sec]?S[x.sec].n:'?'} 的初值副本</b><br>${hx(x.s)} · ${fmt(x.e-x.s)}`};
    const isBig=keep.has(x.o+'_'+x.s);
    const nm=O[x.o]?O[x.o].n:'?';
    return {s:x.s,e:x.e,c:isBig?(M.modules[x.m]||'#7b8794'):'#39424f',
      tip:isBig?`<b>${esc(nm)}</b><br>${esc(O[x.o]?O[x.o].p:'')}<br>${hx(x.s)} · ${fmt(x.e-x.s)}`
              :`其他目标文件累计<br>${hx(x.s)} · ${fmt(x.e-x.s)}`};
  });
}
function sectionItems(r){
  const out=copyItems(r);
  for(const si of r.secs){
    const s=S[si];
    if(!s.sz) continue;
    const role=s.role||'fill';
    out.push({s:s.v,e:s.v+s.sz,c:catColor(role==='fill'?(s.flags.includes('CODE')?'code':'data'):role),
      tip:`<b>${s.n}</b><br>${hx(s.v)} - ${hx(s.v+s.sz)} · ${fmt(s.sz)} (${pct(s.sz,r.len).toFixed(1)}%)<br>
        ${s.noload?'NOLOAD · ':''}符号 ${s.nsym} 个 · 填充 ${fmt(s.pad)}`});
  }
  return out;
}
function renderMap(){
  const host=byId('tab-map'); host.innerHTML='';
  const h=document.createElement('h2');
  h.innerHTML='内存地图 <span class="hint">每行三根条共用同一地址轴: 段 / 模块 / 目标文件; 鼠标悬停看明细, 点击行标题跳到区域详情</span>';
  host.appendChild(h);
  const list=[...DATA.regions].filter(r=>r.secs.length)
    .sort((a,b)=>((M.region_rank[a.n]??50)-(M.region_rank[b.n]??50))||(a.o-b.o));
  for(const r of list){
    const row=document.createElement('div'); row.className='maprow';
    const hd=document.createElement('div'); hd.className='mh';
    hd.innerHTML=`<span class="nm" style="cursor:pointer" title="跳到区域详情">${r.n}</span>
      <span class="info mono">${hx(r.o)} - ${hx(r.o+r.len)} · ${fmt(r.len)} · 已用 ${fmt(r.used)} (${r.pct.toFixed(1)}%)</span>
      ${r.overlays.length?'<span class="pill">含复用段</span>':''}`;
    hd.querySelector('.nm').onclick=()=>{ selectTab('detail'); detailSelect(r.n); };
    row.appendChild(hd);
    // 段
    let lbl=document.createElement('div'); lbl.className='rowlbl'; lbl.textContent='按段'; row.appendChild(lbl);
    row.appendChild(barOf(0,sectionItems(r),r.len,r.o));
    const lg1=document.createElement('div'); lg1.className='lgd';
    lg1.innerHTML=[...r.secs].map(i=>S[i]).filter(s=>s.sz)
      .sort((a,b)=>b.sz-a.sz).slice(0,12)
      .map(s=>`<span><em style="background:${catColor(s.role||(s.flags.includes('CODE')?'code':'data'))}"></em>${s.n} ${fmt(s.sz)}</span>`).join('');
    row.appendChild(lg1);
    const hasObj = X.some(x=>r.secs.indexOf(x[2])>=0) || (r.copies||[]).length;
    if(hasObj){
    // 模块
    lbl=document.createElement('div'); lbl.className='rowlbl'; lbl.textContent='按模块'; row.appendChild(lbl);
    const mit=moduleItems(r); row.appendChild(barOf(0,mit,r.len,r.o,'thin'));
    const agg={};
    for(const x of X){ if(r.secs.indexOf(x[2])<0) continue;
      const mod=O[x[3]]?O[x[3]].m:'其他'; agg[mod]=(agg[mod]||0)+x[1]; }
    for(const [si,lma,sz] of (r.copies||[])) agg['RAM 段初值副本']=(agg['RAM 段初值副本']||0)+sz;
    const lg2=document.createElement('div'); lg2.className='lgd';
    lg2.innerHTML=Object.entries(agg).sort((a,b)=>b[1]-a[1])
      .map(([m,v])=>`<span><em style="background:${M.modules[m]||'#7b8794'}"></em>${m} ${fmt(v)}</span>`).join('');
    row.appendChild(lg2);
    // 目标文件
    lbl=document.createElement('div'); lbl.className='rowlbl'; lbl.textContent='按目标文件 (前 26 大, 其余灰)'; row.appendChild(lbl);
    row.appendChild(barOf(0,objectItems(r),r.len,r.o,'thin'));
    // 复用 bank: 同一地址上互斥的几套缓冲, 每个 bank 单独画一条
    if((r.overlays||[]).length) row.appendChild(bankRows(r));
    } else {
      const hint=document.createElement('div'); hint.className='small'; hint.style.marginTop='6px';
      hint.textContent='该区域由链接脚本直接占位 (栈/堆/对齐), map 里没有目标文件, 因此只有"按段"这一条';
      row.appendChild(hint);
    }
    host.appendChild(row);
  }
}

/* 复用 (overlay) 区域的每个 bank 单独一条, 因为不能相加 */
function bankRows(r){
  const out=document.createElement('div');
  const hd=document.createElement('div'); hd.className='rowlbl';
  hd.textContent='复用 bank: 这几个段落在同一段地址上, 运行时同时只驻留一套, 不能相加';
  out.appendChild(hd);
  for(const g of r.overlays){
    for(const si of g){
      const s=S[si];
      if(!s.sz) continue;
      const row=document.createElement('div'); row.className='bankrow';
      const lab=document.createElement('span'); lab.className='bl';
      lab.innerHTML=`<b>${s.n}</b><i>${fmt(s.sz)}</i>`;
      row.appendChild(lab);
      const segs=[];
      for(const x of X){ if(x[2]!==si) continue;
        segs.push({a:x[0],b:x[0]+x[1],m:O[x[3]]?O[x[3]].m:'其他'}); }
      segs.sort((p,q)=>p.a-q.a);
      const merged=[];
      for(const sg of segs){
        const last=merged[merged.length-1];
        if(last&&last.m===sg.m&&sg.a<=last.e) last.e=Math.max(last.e,sg.b);
        else merged.push({s:sg.a,e:sg.b,m:sg.m});
      }
      const items=merged.map(sg=>({s:sg.s,e:sg.e,c:M.modules[sg.m]||'#7b8794',
        tip:`<b>${s.n}</b> · ${sg.m}<br>${hx(sg.s)} - ${hx(sg.e)} · ${fmt(sg.e-sg.s)}`}));
      if(!items.length) items.push({s:s.v,e:s.v+s.sz,c:'#39424f',
        tip:`<b>${s.n}</b><br>没有目标文件, 由链接脚本占位`});
      const b=barOf(0,items,r.len,r.o,'thin'); b.style.flex='1';
      row.appendChild(b);
      out.appendChild(row);
    }
  }
  return out;
}

/* ---------------- 区域详情 ---------------- */
let detailRegion=null;
function detailSelect(name){
  detailRegion=name;
  document.querySelectorAll('.dside button').forEach(b=>b.classList.toggle('on',b.dataset.r===name));
  renderDetailMain();
}
function renderDetail(){
  const host=byId('tab-detail'); host.innerHTML='';
  const h=document.createElement('h2');
  h.innerHTML='区域详情 <span class="hint">点某一行段展开: 段内目标文件占用 + 全部符号 (变量/函数) 明细</span>';
  host.appendChild(h);
  const wrap=document.createElement('div'); wrap.className='dwrap';
  const side=document.createElement('div'); side.className='dside';
  const list=[...DATA.regions].filter(r=>r.secs.length)
    .sort((a,b)=>((M.region_rank[a.n]??50)-(M.region_rank[b.n]??50))||(a.o-b.o));
  side.innerHTML=list.map(r=>`<button data-r="${r.n}">${r.n}<i>${r.used?fmt(r.used):'-'}</i></button>`).join('');
  side.querySelectorAll('button').forEach(b=>b.onclick=()=>detailSelect(b.dataset.r));
  wrap.appendChild(side);
  const main=document.createElement('div'); main.id='dmain';
  wrap.appendChild(main);
  host.appendChild(wrap);
  if(!detailRegion||!list.find(r=>r.n===detailRegion)){
    const pref=list.find(r=>r.n==='sram')||list.find(r=>r.n==='flash')||list[0];
    detailRegion=pref?pref.n:null;
  }
  if(detailRegion) detailSelect(detailRegion);
}
function renderDetailMain(){
  const main=byId('dmain'); if(!main) return;
  const r=DATA.regions.find(x=>x.n===detailRegion);
  if(!r){ main.innerHTML=''; return; }
  main.innerHTML=`<div class="card" style="margin-bottom:12px">
    <div class="ch"><span class="nm">${r.n}</span>
      <span class="cap mono">${hx(r.o)} - ${hx(r.o+r.len)} · ${fmt(r.len)}</span>
      <span class="pct ${r.pct>92?'bad':(r.pct>80?'warn':'ok')}">${r.pct.toFixed(1)}%</span></div>
    <div class="desc">${esc(r.desc||'')}</div>
    <div class="foot" style="border:0;margin:0;padding:0">
      已用 <b>${fmt(r.used)}</b> · 空闲 <b>${fmt(r.free)}</b>
      · 符号实测占用 <b>${fmt(r.content)}</b>
      · 最大空洞 <b>${fmt(r.largest_hole)}</b> (${r.hole_count} 处)
      ${r.overlays.length?'· 复用段组 <b>'+r.overlays.length+'</b>':''}
    </div></div>`;

  if(r.overlays.length){
    const box=document.createElement('div'); box.className='warnbox';
    box.innerHTML='<b>该区域有地址复用的段</b> (运行时同时只驻留一套, 所以总占用按并集算):<br>' +
      r.overlays.map(g=>'· ' + g.map(i=>S[i].n+' '+fmt(S[i].sz)).join(' &nbsp;|&nbsp; ')).join('<br>');
    main.appendChild(box);
  }

  const tbl=document.createElement('div'); tbl.className='tbl-wrap';
  const t=document.createElement('table');
  t.innerHTML=`<thead><tr><th>段名</th><th class="n">起始</th><th class="n">大小</th>
    <th class="n">占区域</th><th class="n">符号</th><th class="n">变量/其他</th>
    <th class="n">填充</th><th>属性</th></tr></thead><tbody></tbody>`;
  const tb=t.querySelector('tbody');
  const secs=[...r.secs].map(i=>S[i]).sort((a,b)=>a.v-b.v);
  for(const s of secs){
    const tr=document.createElement('tr'); tr.className='secrow';
    tr.innerHTML=`<td>${s.n}</td><td class="n mono">${hx(s.v)}</td><td class="n">${fmt(s.sz)}</td>
      <td class="n">${pct(s.sz,r.len).toFixed(1)}%</td><td class="n">${s.nsym}</td>
      <td class="n">${s.nvar}</td><td class="n">${s.pad?fmt(s.pad):'-'}</td>
      <td class="small">${s.noload?'NOLOAD ':''}${s.role?('角色:'+catLabel(s.role)):''}</td>`;
    const tr2=document.createElement('tr'); tr2.style.display='none';
    const td=document.createElement('td'); td.colSpan=8; td.className='secpanel';
    tr2.appendChild(td);
    let built=false;
    tr.onclick=()=>{
      if(!built){ td.innerHTML=sectionPanel(s,r); built=true; }
      tr2.style.display = tr2.style.display==='none' ? '' : 'none';
    };
    tb.appendChild(tr); tb.appendChild(tr2);
  }
  tbl.appendChild(t); main.appendChild(tbl);
}
function sectionPanel(s,r){
  const objs=(s.objs||[]).slice(0,14);
  const maxo=objs.length?objs[0][1]:1;
  let html='<div class="two"><div><div class="rowlbl">目标文件占用 (前 14)</div>';
  if(objs.length){
    html+='<table>'+(objs.map(([oi,sz,cnt])=>{
      const o=O[oi]||{n:'?',m:'其他'};
      return `<tr><td>${esc(o.n)}</td><td class="small">${o.m}</td>
        <td class="n">${fmt(sz)}</td>
        <td style="width:120px"><div style="height:7px;background:#212b36;border-radius:3px">
        <div style="height:7px;width:${(sz/maxo*100).toFixed(1)}%;background:${M.modules[o.m]||'#7b8794'};border-radius:3px"></div></div></td></tr>`;
    }).join(''))+'</table>';
  } else html+='<div class="small">该段来自链接脚本占位, 没有目标文件</div>';
  html+='</div><div><div class="rowlbl">段属性</div><table>' +
    `<tr><td>VMA</td><td class="mono">${hx(s.v)}</td></tr>`+
    `<tr><td>LMA</td><td class="mono">${s.l===null?'(NOLOAD)':hx(s.l)}</td></tr>`+
    `<tr><td>大小</td><td>${fmt(s.sz)}</td></tr>`+
    `<tr><td>符号覆盖</td><td>${fmt(s.content)}</td></tr>`+
    `<tr><td>填充</td><td>${fmt(s.pad)}</td></tr>`+
    `<tr><td>ELF 属性</td><td class="small">${esc((s.flags||[]).join(', ')||'-')}</td></tr>`+
    '</table></div></div>';
  return html + symbolTable(s);
}
function symbolTable(s){
  const rows=Y.filter(y=>y[2]===s.i);
  if(!rows.length) return '<div class="small" style="margin-top:8px">该段没有命名符号</div>';
  rows.sort((a,b)=>a[0]-b[0]);
  return `<div class="rowlbl" style="margin-top:10px">符号明细 (${rows.length} 个, 按地址)</div>
    <div style="max-height:300px;overflow:auto"><table><thead><tr>
    <th class="n">地址</th><th class="n">大小</th><th>符号</th><th>类型</th>
    <th>分类</th><th>所属目标文件</th></tr></thead><tbody>`+
    rows.map(y=>`<tr><td class="n mono">${hx(y[0])}</td><td class="n">${fmt(y[1])}</td>
      <td class="mono">${esc(y[5])}</td><td class="small">${M.kind_label[y[4]]||y[4]}</td>
      <td class="small" style="color:${catColor(y[6])}">${catLabel(y[6])}</td>
      <td class="small">${y[3]!==null&&O[y[3]]?esc(O[y[3]].n):'-'}</td></tr>`).join('')+
    '</tbody></table></div>';
}

/* ---------------- 变量索引 ---------------- */
let varState={q:'',region:'',kind:'',min:0,limit:400,sort:'size'};
function renderVars(){
  const host=byId('tab-vars'); host.innerHTML='';
  const h=document.createElement('h2');
  h.innerHTML='变量索引 <span class="hint">全部符号 (变量/缓冲/函数), 可按大小排序找大户; 搜索支持符号名/段名/目标文件名</span>';
  host.appendChild(h);
  const regs=[...new Set(Y.map(y=>regName(S[y[2]])))];
  const ctl=document.createElement('div'); ctl.className='ctl';
  ctl.innerHTML=`<input id="vq" placeholder="搜索: 符号名 / 段名 / 目标文件名" value="${esc(varState.q)}">
    <select id="vreg"><option value="">全部区域</option>${regs.map(r=>`<option ${varState.region===r?'selected':''}>${r}</option>`).join('')}</select>
    <select id="vkind">
      <option value="">全部符号</option>
      <option value="O" ${varState.kind==='O'?'selected':''}>只看变量/缓冲</option>
      <option value="F" ${varState.kind==='F'?'selected':''}>只看函数</option>
    </select>
    <select id="vsort">
      <option value="size" ${varState.sort==='size'?'selected':''}>按大小降序</option>
      <option value="addr" ${varState.sort==='addr'?'selected':''}>按地址升序</option>
      <option value="name" ${varState.sort==='name'?'selected':''}>按名字</option>
    </select>
    <span class="small" id="vcount"></span>`;
  host.appendChild(ctl);
  const wrap=document.createElement('div'); wrap.className='tbl-wrap'; wrap.style.maxHeight='none';
  wrap.innerHTML=`<table><thead><tr><th class="n">大小</th><th class="n">地址</th><th>符号</th>
    <th>类型</th><th>区域</th><th>段</th><th>目标文件</th><th class="n">占区域</th></tr></thead>
    <tbody id="vbody"></tbody></table>`;
  host.appendChild(wrap);
  const more=document.createElement('div'); more.style.margin='10px 0';
  more.innerHTML='<button class="chip" id="vmore">显示更多</button>';
  host.appendChild(more);

  const apply=()=>{
    const q=varState.q.toLowerCase();
    let rows=Y.filter(y=>{
      if(varState.kind && y[4]!==varState.kind) return false;
      const rg=regName(S[y[2]]);
      if(varState.region && rg!==varState.region) return false;
      if(q){
        const sname=y[5].toLowerCase(), secn=S[y[2]].n.toLowerCase();
        const objn=y[3]!==null&&O[y[3]]?O[y[3]].n.toLowerCase():'';
        if(!(sname.includes(q)||secn.includes(q)||objn.includes(q))) return false;
      }
      return true;
    });
    if(varState.sort==='size') rows.sort((a,b)=>b[1]-a[1]);
    else if(varState.sort==='addr') rows.sort((a,b)=>a[0]-b[0]);
    else rows.sort((a,b)=>a[5].localeCompare(b[5]));
    byId('vcount').textContent=`命中 ${rows.length} 个`;
    const show=rows.slice(0,varState.limit);
    byId('vbody').innerHTML=show.map(y=>{
      const sec=S[y[2]], r=DATA.regions[sec.r];
      return `<tr><td class="n">${fmt(y[1])}</td><td class="n mono">${hx(y[0])}</td>
        <td class="mono">${esc(y[5])}${y[7]?'<span class="pill">hidden</span>':''}</td>
        <td class="small">${M.kind_label[y[4]]||y[4]}</td>
        <td class="small">${r?r.n:'-'}</td><td class="small">${sec.n}</td>
        <td class="small">${y[3]!==null&&O[y[3]]?esc(O[y[3]].n):'-'}</td>
        <td class="n small">${r?pct(y[1],r.len).toFixed(2)+'%':'-'}</td></tr>`;
    }).join('');
    byId('vmore').style.display = rows.length>varState.limit ? '' : 'none';
    byId('vmore').textContent=`显示更多 (还有 ${rows.length-varState.limit} 个)`;
  };
  byId('vq').oninput=e=>{ varState.q=e.target.value; varState.limit=400; apply(); };
  byId('vreg').onchange=e=>{ varState.region=e.target.value; varState.limit=400; apply(); };
  byId('vkind').onchange=e=>{ varState.kind=e.target.value; varState.limit=400; apply(); };
  byId('vsort').onchange=e=>{ varState.sort=e.target.value; apply(); };
  byId('vmore').onclick=()=>{ varState.limit+=400; apply(); };
  apply();

  // Top 30 大变量
  const h2=document.createElement('h2');
  h2.innerHTML='Top 30 大变量/缓冲 <span class="hint">静态占用, 不含运行时 malloc</span>';
  host.appendChild(h2);
  const top=[...Y].filter(y=>y[4]!=='F').sort((a,b)=>b[1]-a[1]).slice(0,30);
  const mx=top.length?top[0][1]:1;
  const box=document.createElement('div'); box.className='tbl-wrap'; box.style.maxHeight='none';
  box.innerHTML='<table><tbody>'+top.map(y=>{
    const sec=S[y[2]], r=DATA.regions[sec.r];
    return `<tr><td class="mono" style="width:230px">${esc(y[5])}</td>
      <td style="width:100px" class="n">${fmt(y[1])}</td>
      <td><div style="height:9px;background:#212b36;border-radius:3px">
        <div style="height:9px;width:${(y[1]/mx*100).toFixed(1)}%;background:${catColor(y[6])};border-radius:3px"></div></div></td>
      <td class="small" style="width:120px">${r?r.n:'-'} · ${sec.n}</td>
      <td class="small">${y[3]!==null&&O[y[3]]?esc(O[y[3]].n):'-'}</td></tr>`;
  }).join('')+'</tbody></table>';
  host.appendChild(box);
}

/* ---------------- 口径说明 ---------------- */
function renderNotes(){
  const host=byId('tab-notes');
  const t=M.totals;
  let warnHtml='';
  if((M.warnings||[]).length){
    warnHtml='<div class="warnbox"><b>解析提示</b><ul style="margin:6px 0 0 18px;padding:0">'+
      M.warnings.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></div>';
  }
  let html=`<h2>数据来源与计算口径</h2><ul class="note">
  <li><b>区域定义</b> / 容量 / 越界: 直接取 <code>map.txt</code> 的 <code>Memory Configuration</code> 表, 与链接脚本实际解析结果一致, 不读 <code>ram.ld</code> 的宏。</li>
  <li><b>段位置与大小</b>: 取 <code>Linker script and memory map</code> 里的输出段; 段内输入段给出目标文件归属, 符号给出位置。</li>
  <li><b>变量大小</b>: 取自 <code>app.lst</code> 的 <code>SYMBOL TABLE</code> (ELF 符号表里的 size), 不是"到下一个符号的距离"。${M.has_symtab?'':'<b style="color:#e0645c">本次没有 app.lst, 大小是按相邻符号地址推断的, 仅供参考。</b>'}</li>
  <li><b>已用 = 地址并集</b>: 同一区域里地址相接的段只算一次; 地址重叠的段 (复用/overlay) 也算一次, 所以不会把 aram/dram 里十几套缓冲加起来。</li>
  <li><b>Flash 已用</b> 同时计 VMA 与 LMA: RAM 段在 Flash 里有一份初值副本 (图中 "RAM 段初值副本" 那一类), 这正是 <code>app.bin</code> 的体积来源。</li>
  <li><b>符号实测</b> 是把段内所有符号 size 去重后的覆盖长度; 与"已用"的差额是对齐填充和链接器占位 (如 <code>. = 0x5000</code> 这种整块预留)。</li>
  <li><b>不含</b>: 运行时 malloc/free 的动态占用、线程栈实际水位、<code>ui.bin</code>/<code>res.bin</code> 这类资源分区 (它们不在 RAM 里)。</li>
  </ul>`;

  html+=`<h2>本次快照</h2><ul class="note">
  <li>内部 RAM: <b>${fmt(t.internal_ram)}</b> / ${fmt(t.ram_capacity)} (${pct(t.internal_ram,t.ram_capacity).toFixed(1)}%)</li>
  <li>PSRAM: <b>${fmt(t.psram)}</b> / ${fmt(t.psram_capacity)} (${pct(t.psram,t.psram_capacity).toFixed(1)}%)</li>
  <li>Flash: <b>${fmt(t.flash)}</b> / ${fmt(t.flash_capacity)} (${pct(t.flash,t.flash_capacity).toFixed(1)}%)${
    M.app_bin?` · 同目录 app.bin 实际 ${fmt(M.app_bin)} (差 ${fmt(t.flash-M.app_bin)}, 为对齐补零)`:''}</li>
  <li>符号: ${M.nsym} 个 (变量/缓冲 ${M.nvar}, 函数 ${M.nfunc}), 输出段 ${M.nsect} 个</li>
  </ul>`;

  if(DATA.overlap_groups.length){
    html+='<h2>地址复用 / 别名</h2><div class="note">';
    for(const g of DATA.overlap_groups){
      if(g.kind==='alias'){
        html+=`<p><b>${g.names.join(' / ')}</b>: 同一块物理内存的两个视图 (cache 与 uncache), 各自算出来的占用不能相加。
          合并去重后实际占用 <b>${fmt(g.used)}</b> / ${fmt(g.length)}。</p>`;
      }else{
        html+=`<p><b>${g.names.join(' / ')}</b>: 共用 <code>${hx(g.origin)}</code> 起同一段地址, 运行场景互斥。
          各自单独看会重复计算, 该地址段峰值 <b>${fmt(g.used)}</b> / ${fmt(g.capacity)}。</p>`;
      }
    }
    html+='</div>';
  }

  html+=`<h2>怎么用它</h2><ul class="note">
  <li>先看总览里占用率红色/橙色的卡片, 和"最大空洞" (碎片化); 再进内存地图看是哪一块在涨。</li>
  <li>要腾 RAM: 在变量索引按大小排序, 找放在 SRAM 大块 (如 <code>.comm</code>/<code>.bss</code>) 的缓冲; 在区域详情看它属于哪个目标文件。</li>
  <li>要查 Flash: 内存地图里 flash 行的"按模块"条, 能看出代码体积主要是哪一块 (SDK 平台 / 蓝牙栈 / LVGL / 字库)。</li>
  <li>基线对比: 每次构建把 <code>memmap_data.json</code> 留档, 用脚本 diff 两个 JSON 的 <code>regions[].used</code> 即可看出涨在哪。</li>
  </ul>`;
  host.innerHTML=warnHtml+html;
}

/* ---------------- tabs ---------------- */
function selectTab(name){
  document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===name));
  document.querySelectorAll('.tab').forEach(s=>s.classList.toggle('on',s.id==='tab-'+name));
  if(name!=='detail') history.replaceState(null,'','#'+name);
  window.scrollTo({top:0,behavior:'instant'});
}
document.querySelectorAll('nav.tabs button').forEach(b=>b.onclick=()=>selectTab(b.dataset.tab));

/* ---------------- 字号缩放: 记住上次选择 ---------------- */
const SCALES=[1,1.15,1.3,1.45,1.6];
let scaleIdx=0;
try{
  const saved=parseFloat(localStorage.getItem('mmScale')||'1');
  const i=SCALES.findIndex(v=>Math.abs(v-saved)<1e-6);
  if(i>=0) scaleIdx=i;
}catch(e){}
function applyScale(){
  const s=SCALES[scaleIdx];
  document.documentElement.style.setProperty('--ui-scale',s);
  byId('zval').textContent=Math.round(s*100)+'%';
  try{ localStorage.setItem('mmScale',s); }catch(e){}
}
byId('zin').onclick=()=>{ scaleIdx=Math.min(SCALES.length-1,scaleIdx+1); applyScale(); };
byId('zout').onclick=()=>{ scaleIdx=Math.max(0,scaleIdx-1); applyScale(); };
applyScale();

/* ---------------- boot ---------------- */
(function boot(){
  const shortPath = p => {
    if(!p) return '';
    const parts = p.replace(/\\/g,'/').split('/');
    return parts.length<=4 ? p : '…/' + parts.slice(-4).join('/');
  };
  byId('src').innerHTML =
    `<div><b>map</b> <span class="pth" title="${esc(M.map)}">${esc(shortPath(M.map))}</span></div>`+
    `<div><b>lst</b> <span class="pth" title="${esc(M.lst||'')}">${esc(M.lst?shortPath(M.lst):'未提供')}</span>`+
    ` · 符号表 ${M.has_symtab?'可用':'缺失 (大小按相邻地址推断)'}</div>`+
    `<div style="font-size:12.5px">生成于 ${esc(M.generated)} · 符号 ${M.nsym} 个 · 输出段 ${M.nsect} 个</div>`;
  renderKpis(); renderOverview(); renderMap(); renderDetail(); renderVars(); renderNotes();
  const h=(location.hash||'').replace('#','');
  if(['overview','map','detail','vars','notes'].includes(h)) selectTab(h);
})();
</script>
</body>
</html>
'''

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def guess_defaults():
    here = os.path.dirname(os.path.abspath(__file__))
    sdk = os.path.dirname(os.path.dirname(here))
    base = os.path.join(sdk, 'app', 'projects', 'standard')
    return (os.path.join(base, 'Output', 'bin', 'map.txt'),
            os.path.join(base, 'Output', 'bin', 'app.lst'),
            os.path.join(base, 'ram.ld'),
            os.path.join(here, 'out'))


def main(argv=None):
    dmap, _dlst, _dld, dout = guess_defaults()
    for stream in (sys.stdout, sys.stderr):
        try:                      # 控制台编码可能是 ascii (CI), 别让打印把整次分析弄挂
            stream.reconfigure(errors='replace')
        except Exception:
            pass
    ap = argparse.ArgumentParser(
        description='分析 AB579x SDK 构建产物的内存分布, 生成 HTML/JSON 报告')
    ap.add_argument('--map', default=None, help='map.txt 路径 (默认: 本工具所属 SDK 的 standard 工程)')
    ap.add_argument('--lst', default=None,
                    help='app.lst 路径 (默认: 与 map.txt 同目录; 不存在则用 map 符号推断大小)')
    ap.add_argument('--ld', default=None, help='ram.ld 路径 (默认: map 所在工程的 ram.ld, 仅作元信息)')
    ap.add_argument('--out', default=dout, help='输出目录 (默认: 本工具目录下的 out/)')
    ap.add_argument('--name', default='', help='报告标题里的工程名')
    ap.add_argument('--json-only', action='store_true', help='只输出 JSON')
    ap.add_argument('--open', action='store_true', help='生成后用浏览器打开 HTML')
    args = ap.parse_args(argv)

    map_path = args.map or dmap
    if not os.path.exists(map_path):
        print('错误: 找不到 map.txt: %s' % map_path, file=sys.stderr)
        return 2
    bin_dir = os.path.dirname(os.path.abspath(map_path))
    proj_dir = os.path.dirname(os.path.dirname(bin_dir))       # Output/bin -> 工程目录

    # 默认值一律从 map.txt 的位置推, 避免串到另一个工程的 app.lst
    lst = args.lst if args.lst is not None else os.path.join(bin_dir, 'app.lst')
    ld = args.ld if args.ld is not None else os.path.join(proj_dir, 'ram.ld')
    if not os.path.exists(lst):
        print('提示: 没有 app.lst (%s), 变量大小将按相邻符号地址推断' % lst, file=sys.stderr)
        lst = None
    elif args.lst is None and os.path.dirname(os.path.abspath(lst)).lower() != bin_dir.lower():
        print('提示: 默认 app.lst 不在 map.txt 同一目录, 已忽略', file=sys.stderr)
        lst = None
    if ld and not os.path.exists(ld):
        ld = None

    try:
        model = build_model(map_path, lst, ld)
    except RuntimeError as e:
        print('错误: %s' % e, file=sys.stderr)
        print('该工具要求 GNU ld 的 map 文件 (含 Memory Configuration 表); '
              'lld/readelf 导出的 map 不支持', file=sys.stderr)
        return 2
    compute(model)
    data = to_json(model)
    data['meta']['project'] = args.name or os.path.basename(proj_dir)

    os.makedirs(args.out, exist_ok=True)
    jpath = os.path.join(args.out, 'memmap_data.json')
    with io.open(jpath, 'w', encoding='utf-8') as f:
        f.write(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    print_summary(model, data)
    print('')
    print('JSON: %s' % jpath)
    hpath = None
    if not args.json_only:
        hpath = os.path.join(args.out, 'memmap_report.html')
        with io.open(hpath, 'w', encoding='utf-8') as f:
            f.write(render_html(data))
        print('HTML: %s' % hpath)
    if args.open and hpath and hasattr(os, 'startfile'):
        os.startfile(hpath)  # noqa: 仅 Windows 桌面环境
    return 0


if __name__ == '__main__':
    sys.exit(main())
