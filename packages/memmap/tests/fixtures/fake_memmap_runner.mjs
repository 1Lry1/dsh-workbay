/**
 * Fake `memmap_report.py` for tests and the browser harness.
 *
 * The host spawns `<python> <this file> <tool.py> --map <map> --out <dir> --name <p>`.
 * It writes the same two artefacts the real script writes, so the whole run/
 * summary/delta/report path is exercised without Python being installed.
 *
 * Environment knobs:
 *   FAKE_MEMMAP_BUMP  add N bytes to the sram region + one variable (delta tests)
 *   FAKE_MEMMAP_FAIL  1 → write to stderr and exit 3 (failure path)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
/* The host probes python with -c 'import sys; print(...)'; answer like python. */
if (argv[0] === '-c') {
  process.stdout.write('3.9.10-fake\n')
  process.exit(0)
}
const valueOf = (flag) => {
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : ''
}
const mapPath = valueOf('--map')
const outDir = valueOf('--out')
const project = valueOf('--name') || 'standard'
const bump = Number(process.env.FAKE_MEMMAP_BUMP || '0') || 0

if (process.env.FAKE_MEMMAP_FAIL === '1') {
  process.stderr.write('boom: unsupported map format\n')
  process.exit(3)
}
if (mapPath === '' || outDir === '') {
  process.stderr.write('missing --map or --out\n')
  process.exit(2)
}
let mapSize = 0
try {
  mapSize = readFileSync(mapPath).length
} catch (error) {
  process.stderr.write('cannot read map: ' + error.message + '\n')
  process.exit(2)
}
void mapSize

const sramUsed = 300_000 + bump
const psramUsed = 3_620_000
const flashUsed = 1_540_000
const data = {
  meta: {
    map: mapPath,
    lst: null,
    ld: null,
    has_symtab: true,
    generated: '2026-11-11 20:00:00',
    nsym: 4,
    nvar: 2,
    nfunc: 2,
    nsect: 4,
    totals: {
      internal_ram: 473_000 + bump,
      ram_capacity: 651_520,
      psram: psramUsed,
      psram_capacity: 4_194_304,
      flash: flashUsed,
      flash_capacity: 3_138_048,
    },
    modules: { 'SDK 平台': '#4f8cff' },
    cat_color: { code: '#4f8cff', rodata: '#2bb673', data: '#f2b134', bss: '#9b6cf0', buffer: '#35b8c9' },
    cat_label: { code: '代码', data: '已初始化数据', bss: '未初始化/运行时初始化', buffer: '算法/绘制缓冲' },
    cat_order: ['code', 'rodata', 'data', 'bss', 'buffer'],
    kind_label: { F: '函数', O: '变量/缓冲' },
    region_rank: { sram: 6, psram: 20, flash: 1 },
    warnings: bump > 0 ? ['sram 的占用比上次多，注意 RAM 余量'] : [],
    app_bin: 1_612_288,
    project,
  },
  regions: [
    {
      n: 'sram', o: 536_870_912, len: 655_360, attrs: '', desc: '主 SRAM: 常驻代码 + 全局变量',
      used: sramUsed, vma: sramUsed, lma: sramUsed, content: sramUsed, free: 655_360 - sramUsed,
      pct: Math.round((sramUsed / 655_360) * 1000) / 10,
      cats: { code: 180_000, data: 20_000, bss: sramUsed - 200_000 },
      secs: [0, 1], copies: [], overlays: [], overlay_union: 0, overlay_sum: 0, alias: [], alias_used: 0,
      grp: null, largest_hole: 1024, hole_count: 2,
    },
    {
      n: 'psram', o: 805_306_368, len: 4_194_304, attrs: '', desc: 'PSRAM cache 视图',
      used: psramUsed, vma: psramUsed, lma: psramUsed, content: psramUsed, free: 4_194_304 - psramUsed,
      pct: 86.3,
      cats: { code: 500_000, rodata: 1_000_000, buffer: psramUsed - 1_500_000 },
      secs: [2], copies: [], overlays: [], overlay_union: 0, overlay_sum: 0, alias: ['uncache_psram'], alias_used: psramUsed,
      grp: null, largest_hole: 0, hole_count: 0,
    },
    {
      n: 'flash', o: 268_435_456, len: 3_138_048, attrs: '', desc: '内部 Flash 程序区',
      used: flashUsed, vma: 1_300_000, lma: flashUsed, content: flashUsed, free: 3_138_048 - flashUsed,
      pct: 49.1,
      cats: { code: 1_100_000, rodata: 300_000, copy: 140_000 },
      secs: [3], copies: [0, 1], overlays: [], overlay_union: 0, overlay_sum: 0, alias: [], alias_used: 0,
      grp: null, largest_hole: 0, hole_count: 0,
    },
  ],
  objects: [
    { n: 'libplatform.a(reset.o)', p: 'app/platform/libs/libplatform.a(reset.o)', m: 'SDK 平台', sz: 504 },
    { n: 'lvgl.a(lv_obj.o)', p: 'lvgl/src/core/lv_obj.o', m: 'LVGL', sz: 120_000 + bump },
    { n: 'app_main.o', p: 'app/main/app_main.o', m: '应用功能', sz: 8_000 },
  ],
  symbols: [
    [536_900_000, 1_170_000, 2, 1, 'O', 'work_mem_int.4', 'buffer', 0],
    [536_901_000, 20_000 + bump, 0, 2, 'O', 's_snap_cache', 'bss', 0],
    [536_902_000, 12_000, 0, 2, 'O', 'lv_port_disp_init', 'data', 0],
    [537_000_000, 4_000, 3, 0, 'F', 'main', 'code', 0],
    [537_004_000, 3_000, 3, 0, 'F', 'lv_timer_handler', 'code', 0],
  ],
  sections: [],
  extents: [],
  overlap_groups: [{ names: ['psram', 'uncache_psram'], origin: 805_306_368, capacity: 4_194_304, used: psramUsed, kind: 'alias' }],
}

mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'memmap_data.json'), JSON.stringify(data), 'utf8')
writeFileSync(path.join(outDir, 'memmap_report.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>memmap fake</title></head><body>' +
  '<h1>内存分布分析 (fake)</h1><p id="marker">sram ' + sramUsed + '</p>' +
  '<script>window.__FAKE_REPORT__ = 1</script></body></html>\n', 'utf8')

process.stdout.write('工程: ' + project + '\n')
process.stdout.write('内部 RAM: sram used ' + sramUsed + '\n')
process.stdout.write('JSON: ' + path.join(outDir, 'memmap_data.json') + '\n')
process.stdout.write('HTML: ' + path.join(outDir, 'memmap_report.html') + '\n')
