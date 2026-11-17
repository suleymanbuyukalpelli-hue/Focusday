$ErrorActionPreference = "Stop"

Write-Host "FocusDay projesi oluşturuluyor..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js bulunamadı. Önce Node.js LTS kurun: https://nodejs.org"
}

if (Test-Path "focusday") {
  Write-Error "focusday klasörü zaten var. Başka bir klasörde çalıştırın veya mevcut klasörü yedekleyin."
}

npm create vite@latest focusday -- --template react-ts
Set-Location focusday

@'
import { useEffect, useMemo, useState } from 'react'
import './index.css'

type Goal = { id: number; title: string; date: string; completed: boolean; repeat: string }
type Reminder = { id: number; title: string; date: string; time: string; repeat: string }
type Screen = 'home' | 'goals' | 'reminders' | 'pomodoro' | 'reports'

const today = new Date().toISOString().slice(0, 10)

const initialGoals: Goal[] = [
  { id: 1, title: 'Raporu tamamla', date: today, completed: true, repeat: 'Tek seferlik' },
  { id: 2, title: 'İngilizce çalış', date: today, completed: false, repeat: 'Her gün' },
  { id: 3, title: 'Günlük planı gözden geçir', date: today, completed: false, repeat: 'Her Salı' },
]

const initialReminders: Reminder[] = [
  { id: 1, title: 'Haftalık toplantı', date: today, time: '09:00', repeat: 'Her Salı' },
  { id: 2, title: 'Faturayı kontrol et', date: today, time: '14:30', repeat: 'Tek seferlik' },
]

function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || '') as T } catch { return fallback }
}

function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [goals, setGoals] = useState<Goal[]>(() => load('focusday-goals', initialGoals))
  const [reminders] = useState<Reminder[]>(() => load('focusday-reminders', initialReminders))
  const [seconds, setSeconds] = useState(25 * 60)
  const [running, setRunning] = useState(false)
  const [focusNote, setFocusNote] = useState('')
  const [newGoal, setNewGoal] = useState('')
  const [newReminder, setNewReminder] = useState('')
  const [pomodoros, setPomodoros] = useState(() => Number(localStorage.getItem('focusday-pomodoros') || 0))

  useEffect(() => { localStorage.setItem('focusday-goals', JSON.stringify(goals)) }, [goals])
  useEffect(() => { localStorage.setItem('focusday-reminders', JSON.stringify(reminders)) }, [reminders])
  useEffect(() => { localStorage.setItem('focusday-pomodoros', String(pomodoros)) }, [pomodoros])
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setSeconds(value => {
      if (value <= 1) { setRunning(false); setPomodoros(count => count + 1); return 25 * 60 }
      return value - 1
    }), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const completed = goals.filter(goal => goal.completed).length
  const progress = goals.length ? Math.round(completed / goals.length * 100) : 0
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const dateText = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())

  function toggleGoal(id: number) {
    setGoals(items => items.map(goal => goal.id === id ? { ...goal, completed: !goal.completed } : goal))
  }

  function addGoal() {
    if (!newGoal.trim()) return
    setGoals(items => [...items, { id: Date.now(), title: newGoal.trim(), date: today, completed: false, repeat: 'Tek seferlik' }])
    setNewGoal('')
  }

  function addReminder() {
    if (!newReminder.trim()) return
    const saved = load<Reminder[]>('focusday-reminders', initialReminders)
    localStorage.setItem('focusday-reminders', JSON.stringify([...saved, { id: Date.now(), title: newReminder.trim(), date: today, time: '09:00', repeat: 'Tek seferlik' }]))
    setNewReminder('')
    alert('Hatırlatma kaydedildi. Ayrıntılı form bir sonraki sürümde eklenecek.')
  }

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark">F</div><div><strong>FocusDay</strong><small>Gününü odakla</small></div><button className="icon-button" onClick={() => alert('Bildirimler yakında eklenecek.')}>♧</button></header>

    <main>
      {screen === 'home' && <>
        <section className="welcome"><p className="eyebrow">{dateText}</p><h1>Günaydın, Süleyman</h1><p>Bugün neye odaklanmak istersin?</p></section>
        <section className="progress-card"><div><p className="eyebrow">Bugünkü ilerlemen</p><h2>{completed} / {goals.length} hedef tamamlandı</h2><div className="progress-line"><span style={{ width: `${progress}%` }} /></div><small>{progress}% tamamlandı</small></div><div className="progress-ring" style={{ '--progress': `${progress * 3.6}deg` } as React.CSSProperties}><b>{progress}%</b></div></section>
        <section className="card"><div className="section-heading"><h2>Bugünün hedefleri</h2><button onClick={() => setScreen('goals')}>Tümünü gör</button></div>{goals.slice(0, 3).map(goal => <GoalRow key={goal.id} goal={goal} onToggle={() => toggleGoal(goal.id)} />)}</section>
        <section className="card"><div className="section-heading"><h2>Yaklaşan hatırlatmalar</h2><button onClick={() => setScreen('reminders')}>Tümünü gör</button></div>{reminders.map(item => <div className="reminder-row" key={item.id}><span className="reminder-dot">◷</span><div><strong>{item.title}</strong><small>{item.repeat}</small></div><time>{item.time}</time></div>)}</section>
        <button className="primary wide" onClick={() => setScreen('pomodoro')}>▶ Pomodoro başlat</button>
      </>}

      {screen === 'goals' && <><PageTitle title="Hedefler" /><div className="tabs"><button className="active">Bugün</button><button>Yaklaşan</button><button>Tamamlanan</button></div><section className="card">{goals.map(goal => <GoalRow key={goal.id} goal={goal} onToggle={() => toggleGoal(goal.id)} />)}</section><section className="quick-add"><input value={newGoal} onChange={e => setNewGoal(e.target.value)} placeholder="Yeni hedef yaz..." onKeyDown={e => e.key === 'Enter' && addGoal()} /><button className="primary" onClick={addGoal}>Ekle</button></section></>}

      {screen === 'reminders' && <><PageTitle title="Hatırlatmalar" /><section className="card form-card"><label>Hatırlatma başlığı</label><input value={newReminder} onChange={e => setNewReminder(e.target.value)} placeholder="Örn. Haftalık toplantı" /><label>Tarih</label><input type="date" defaultValue={today} /><label>Saat</label><input type="time" defaultValue="09:00" /><label>Tekrar</label><select defaultValue="Tek seferlik"><option>Tek seferlik</option><option>Her gün</option><option>Her hafta</option><option>Her ay</option></select><button className="primary wide" onClick={addReminder}>Hatırlatmayı kaydet</button></section><section className="card">{reminders.map(item => <div className="reminder-row" key={item.id}><span className="reminder-dot">◷</span><div><strong>{item.title}</strong><small>{item.date} · {item.repeat}</small></div><time>{item.time}</time></div>)}</section></>}

      {screen === 'pomodoro' && <><PageTitle title="Pomodoro" /><section className="timer-card"><p className="eyebrow">Bağımsız odaklanma</p><div className="timer-ring"><strong>{time}</strong><span>{running ? 'Odaklanıyor' : 'Başlamaya hazır'}</span></div><input value={focusNote} onChange={e => setFocusNote(e.target.value)} placeholder="Odaklanma konusu (isteğe bağlı)" /><div className="timer-actions"><button className="primary" onClick={() => setRunning(!running)}>{running ? '❚❚ Duraklat' : '▶ Başlat'}</button><button className="secondary" onClick={() => { setRunning(false); setSeconds(25 * 60) }}>Sıfırla</button></div><p className="session-count">Tamamlanan Pomodoro: <b>{pomodoros}</b></p></section></>}

      {screen === 'reports' && <><PageTitle title="Raporlar" /><select className="period"><option>Bu hafta</option><option>Bu ay</option><option>Son 30 gün</option></select><div className="stats-grid"><Stat title="Tamamlanan hedefler" value={String(completed)} color="green" /><Stat title="Pomodoro" value={String(pomodoros)} color="blue" /><Stat title="Odaklanma süresi" value={`${pomodoros * 25} dk`} color="purple" /></div><section className="card chart-card"><h2>Haftalık odaklanma</h2><div className="chart">{['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'].map((day, index) => <div className="bar-column" key={day}><div className={`bar bar-${index % 3}`} style={{ height: `${30 + (index * 13) % 65}%` }} /><small>{day}</small></div>)}</div></section><div className="insight">✦ Bu hafta düzenli ilerliyorsun. Küçük adımlar büyük sonuçlar getirir.</div></>}
    </main>

    <nav className="bottom-nav">{[['home','⌂','Ana Sayfa'],['goals','✓','Hedefler'],['reminders','◷','Hatırlatmalar'],['pomodoro','◉','Pomodoro'],['reports','▥','Raporlar']].map(([id, icon, label]) => <button className={screen === id ? 'selected' : ''} key={id} onClick={() => setScreen(id as Screen)}><span>{icon}</span>{label}</button>)}</nav>
  </div>
}

function GoalRow({ goal, onToggle }: { goal: Goal; onToggle: () => void }) { return <div className="goal-row"><button className={`check ${goal.completed ? 'done' : ''}`} onClick={onToggle}>{goal.completed ? '✓' : ''}</button><div><strong className={goal.completed ? 'completed' : ''}>{goal.title}</strong><small>{goal.repeat}</small></div></div> }
function PageTitle({ title }: { title: string }) { return <div className="page-title"><h1>{title}</h1><button className="icon-button">＋</button></div> }
function Stat({ title, value, color }: { title: string; value: string; color: string }) { return <div className={`stat ${color}`}><strong>{value}</strong><small>{title}</small></div> }

export default App
'@ | Set-Content -Encoding UTF8 src/App.tsx

@'
:root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17212b; background: #f4f7f8; font-synthesis: none; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #f4f7f8; }
button, input, select { font: inherit; }
button { border: 0; cursor: pointer; }
.app-shell { width: 100%; max-width: 520px; min-height: 100vh; margin: 0 auto; padding-bottom: 92px; background: #f4f7f8; }
.topbar { height: 72px; padding: 16px 20px; display: flex; align-items: center; gap: 11px; background: #fff; border-bottom: 1px solid #e6ecee; }
.brand-mark { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; background: #1769aa; color: #fff; font-weight: 800; font-size: 21px; }
.topbar strong { display: block; font-size: 17px; }.topbar small { color: #71808a; }.icon-button { margin-left: auto; background: transparent; color: #1769aa; font-size: 24px; }
main { padding: 22px 18px; }.welcome h1, .page-title h1 { margin: 2px 0 5px; font-size: 26px; letter-spacing: -.5px; }.welcome p:not(.eyebrow) { margin: 0 0 20px; color: #71808a; }.eyebrow { margin: 0 0 5px; color: #1769aa; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; }
.card, .progress-card, .timer-card { background: #fff; border-radius: 20px; padding: 18px; margin: 14px 0; box-shadow: 0 4px 18px rgba(23,33,43,.05); }.progress-card { display: flex; justify-content: space-between; align-items: center; background: #17212b; color: #fff; }.progress-card .eyebrow { color: #e4c441; }.progress-card h2 { margin: 6px 0 10px; font-size: 18px; }.progress-card small { color: #c8d1d5; }.progress-line { width: 180px; height: 7px; margin: 8px 0; overflow: hidden; border-radius: 10px; background: #42515b; }.progress-line span { display: block; height: 100%; border-radius: inherit; background: #5e8c61; }.progress-ring { width: 74px; height: 74px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(#e4c441 var(--progress), #42515b 0); position: relative; }.progress-ring:after { content: ''; position: absolute; inset: 7px; background: #17212b; border-radius: 50%; }.progress-ring b { position: relative; z-index: 1; }
.section-heading, .page-title { display: flex; justify-content: space-between; align-items: center; }.section-heading h2, .card h2 { margin: 0 0 14px; font-size: 16px; }.section-heading button { color: #1769aa; background: transparent; font-size: 12px; font-weight: 700; }.goal-row, .reminder-row { min-height: 55px; display: flex; align-items: center; gap: 12px; border-top: 1px solid #edf1f2; }.goal-row:first-of-type, .reminder-row:first-of-type { border-top: 0; }.goal-row strong, .reminder-row strong { display: block; font-size: 14px; }.goal-row small, .reminder-row small { display: block; margin-top: 3px; color: #71808a; font-size: 12px; }.completed { text-decoration: line-through; color: #71808a; }.check { width: 25px; height: 25px; flex: 0 0 25px; border: 2px solid #b9c8cc; border-radius: 50%; background: #fff; color: #fff; }.check.done { border-color: #5e8c61; background: #5e8c61; }.reminder-dot { width: 31px; height: 31px; display: grid; place-items: center; border-radius: 10px; background: #fff0df; color: #e58b32; font-size: 19px; }.reminder-row time { margin-left: auto; color: #17212b; font-weight: 700; font-size: 13px; }
.primary, .secondary { min-height: 45px; padding: 0 18px; border-radius: 12px; font-weight: 700; }.primary { color: #fff; background: #1769aa; }.primary:hover { background: #125583; }.secondary { color: #1769aa; background: #e8f1f7; }.wide { width: 100%; margin-top: 5px; }.tabs { display: flex; gap: 7px; margin: 18px 0; overflow-x: auto; }.tabs button { padding: 10px 13px; border-radius: 20px; color: #71808a; background: #e6ecee; white-space: nowrap; }.tabs .active { color: #fff; background: #1769aa; }.quick-add { display: flex; gap: 8px; }.quick-add input { min-width: 0; flex: 1; }.form-card { display: grid; gap: 8px; }.form-card label { margin-top: 7px; color: #53636c; font-size: 13px; font-weight: 700; }.form-card input, .form-card select, .quick-add input, .timer-card input, .period { width: 100%; min-height: 45px; padding: 0 12px; border: 1px solid #dce5e7; border-radius: 10px; background: #fff; color: #17212b; }.timer-card { text-align: center; padding: 28px 18px; }.timer-ring { width: 230px; height: 230px; margin: 16px auto 24px; display: flex; flex-direction: column; justify-content: center; border: 12px solid #e4c441; border-right-color: #1769aa; border-radius: 50%; }.timer-ring strong { font-size: 43px; letter-spacing: -2px; }.timer-ring span { color: #71808a; font-size: 13px; }.timer-actions { display: flex; gap: 8px; margin-top: 12px; }.timer-actions button { flex: 1; }.session-count { color: #71808a; font-size: 13px; }.period { margin: 12px 0; }.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }.stat { min-height: 107px; padding: 14px 10px; display: flex; flex-direction: column; justify-content: space-between; border-radius: 15px; background: #fff; border-top: 4px solid #1769aa; }.stat strong { font-size: 22px; }.stat small { color: #71808a; line-height: 1.2; }.stat.green { border-color: #5e8c61; }.stat.blue { border-color: #1769aa; }.stat.purple { border-color: #7656a6; }.chart-card { margin-top: 14px; }.chart { height: 190px; display: flex; align-items: end; justify-content: space-around; gap: 8px; padding-top: 22px; }.bar-column { height: 100%; flex: 1; display: flex; flex-direction: column; justify-content: end; align-items: center; gap: 8px; }.bar { width: 18px; min-height: 25px; border-radius: 7px 7px 2px 2px; }.bar-0 { background: #1769aa; }.bar-1 { background: #5e8c61; }.bar-2 { background: #e4c441; }.bar-column small { color: #71808a; font-size: 11px; }.insight { margin-top: 14px; padding: 16px; border-radius: 15px; background: #eee9f6; color: #7656a6; font-size: 13px; line-height: 1.5; }
.bottom-nav { position: fixed; z-index: 5; bottom: 0; left: 50%; width: 100%; max-width: 520px; transform: translateX(-50%); display: grid; grid-template-columns: repeat(5, 1fr); padding: 9px 5px max(9px, env(safe-area-inset-bottom)); background: rgba(255,255,255,.97); border-top: 1px solid #e6ecee; }.bottom-nav button { display: flex; flex-direction: column; align-items: center; gap: 4px; color: #8a989e; background: transparent; font-size: 10px; }.bottom-nav button span { font-size: 20px; line-height: 20px; }.bottom-nav button.selected { color: #1769aa; font-weight: 700; }
@media (min-width: 700px) { body { padding: 24px 0; }.app-shell { border-radius: 24px; overflow: hidden; box-shadow: 0 8px 35px rgba(23,33,43,.1); } }
'@ | Set-Content -Encoding UTF8 src/index.css

npm install
Write-Host "" 
Write-Host "FocusDay hazır! Şimdi şu komutu çalıştırın: npm run dev" -ForegroundColor Green
Write-Host "Tarayıcıda açılacak adres genellikle: http://localhost:5173" -ForegroundColor Yellow
