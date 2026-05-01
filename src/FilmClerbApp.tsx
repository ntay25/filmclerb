import { AuthFlow } from './components/auth/AuthFlow'
import { Navbar } from './components/Navbar'
import { FilmClerbStudio } from './components/screener/FilmClerbStudio'
import { Toasts } from './components/Toast'
import { useAuthStore } from './stores/auth'

export default function FilmClerbApp() {
  const step = useAuthStore((s) => s.step)

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col">
        {step === 'connected' ? <FilmClerbStudio /> : <AuthFlow />}
      </div>
      <Toasts />
    </div>
  )
}
