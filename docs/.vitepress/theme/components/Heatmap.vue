<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import heatmap from '../../generated/heatmap.json'

const WEEK_COUNT = 53
const DAY = 86400000
const offset = ref(0)
const scroller = ref(null)

async function pinToRecent() {
  await nextTick()
  if (scroller.value) scroller.value.scrollLeft = scroller.value.scrollWidth
}

onMounted(pinToRecent)
watch(offset, pinToRecent)

const counts = heatmap.counts as Record<string, number>

function parseUtc(iso: string) {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10))
  return Date.UTC(year, month - 1, day)
}

function formatUtc(ts: number) {
  const date = new Date(ts)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function levelFor(count: number) {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count === 2) return 2
  if (count <= 4) return 3
  if (count <= 6) return 4
  return 5
}

function mondayOnOrBefore(ts: number) {
  const day = new Date(ts).getUTCDay()
  const delta = (day + 6) % 7
  return ts - delta * DAY
}

const asOf = parseUtc(heatmap.asOf)

const weeks = computed(() => {
  const end = mondayOnOrBefore(asOf) + 6 * DAY - offset.value * 28 * DAY
  const start = mondayOnOrBefore(end) - (WEEK_COUNT - 1) * 7 * DAY
  const columns = []

  for (let week = 0; week < WEEK_COUNT; week += 1) {
    const cells = []
    for (let row = 0; row < 7; row += 1) {
      const ts = start + (week * 7 + row) * DAY
      const iso = formatUtc(ts)
      const count = counts[iso] || 0
      const future = ts > asOf
      let title = `${iso} 未更新`
      if (future) title = '别急，这一天还没来'
      else if (count > 0) title = `于 ${iso} 更新了 ${count} 篇博文`
      cells.push({
        iso,
        count,
        level: future ? 0 : levelFor(count),
        title,
        month: new Date(ts).getUTCMonth(),
      })
    }
    columns.push(cells)
  }

  return columns
})

const monthLabels = computed(() => {
  const labels: string[] = []
  let previous = -1
  for (const week of weeks.value) {
    const month = week[0]?.month ?? previous
    if (month !== previous) {
      labels.push(`${month + 1}月`)
      previous = month
    } else {
      labels.push('')
    }
  }
  return labels
})

function shift(next: number) {
  offset.value = Math.max(0, Math.min(18, offset.value + next))
}
</script>

<template>
  <section class="learn-heat" aria-label="学习指数">
    <div class="learn-heat-head">
      <div class="learn-heat-title">学习指数</div>
      <div class="learn-heat-nav">
        <button type="button" @click="shift(1)">← Prev</button>
        <button type="button" :disabled="offset === 0" @click="shift(-1)">Next →</button>
      </div>
    </div>

    <div ref="scroller" class="learn-heat-scroll">
      <div class="learn-heat-board">
        <div class="learn-heat-days" aria-hidden="true">
          <span class="learn-heat-days-pad" />
          <span>一</span>
          <span />
          <span>三</span>
          <span />
          <span>五</span>
          <span />
          <span>日</span>
        </div>
        <div>
          <div class="learn-heat-months">
            <span v-for="(label, index) in monthLabels" :key="index">{{ label }}</span>
          </div>
          <div class="learn-heat-grid">
            <div v-for="(week, weekIndex) in weeks" :key="weekIndex" class="learn-heat-col">
              <i
                v-for="cell in week"
                :key="cell.iso"
                :class="['learn-heat-cell', `lv-${cell.level}`]"
                :title="cell.title"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="learn-heat-legend">
      <span>懈怠</span>
      <i class="learn-heat-cell lv-0" />
      <i class="learn-heat-cell lv-1" />
      <i class="learn-heat-cell lv-2" />
      <i class="learn-heat-cell lv-3" />
      <i class="learn-heat-cell lv-4" />
      <i class="learn-heat-cell lv-5" />
      <span>努力</span>
    </div>
  </section>
</template>

<style scoped>
.learn-heat {
  margin: 28px 0 36px;
  padding: 8px 0 4px;
}

.learn-heat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.learn-heat-title {
  font-size: 16px;
  font-weight: 600;
}

.learn-heat-nav {
  display: flex;
  gap: 8px;
}

.learn-heat-nav button {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
}

.learn-heat-nav button:disabled {
  opacity: 0.45;
  cursor: default;
}

.learn-heat-scroll {
  overflow-x: auto;
  padding-bottom: 8px;
}

.learn-heat-board {
  display: flex;
  gap: 8px;
}

.learn-heat-days {
  display: grid;
  grid-template-rows: 14px repeat(7, 14px);
  gap: 4px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  line-height: 14px;
}

.learn-heat-days-pad {
  height: 14px;
}

.learn-heat-months,
.learn-heat-grid {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 16px;
  gap: 4px;
  width: max-content;
}

.learn-heat-months {
  margin-bottom: 4px;
  color: var(--vp-c-text-2);
  font-size: 12px;
  line-height: 1;
}

.learn-heat-months span {
  display: block;
  height: 14px;
  white-space: nowrap;
}

.learn-heat-col {
  display: grid;
  grid-template-rows: repeat(7, 14px);
  gap: 4px;
}

.learn-heat-cell {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 2px;
  background: var(--heat-0);
}

.lv-0 { background: var(--heat-0); }
.lv-1 { background: #daf6ea; }
.lv-2 { background: #c7f0df; }
.lv-3 { background: #82edc0; }
.lv-4 { background: #0bd07d; }
.lv-5 { background: #00663b; }

.learn-heat-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 12px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.learn-heat {
  --heat-0: #ebedf0;
}

.dark .learn-heat {
  --heat-0: #2d333b;
}
</style>
