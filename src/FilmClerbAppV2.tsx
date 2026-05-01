import { AuthFlow } from './components/auth/AuthFlow'
import { Navbar } from './components/Navbar'
import { FilmClerbStudioV2 } from './components/screener/FilmClerbStudioV2'
import { Toasts } from './components/Toast'
import { useAuthStore } from './stores/auth'

export default function FilmClerbAppV2() {
  const step = useAuthStore((s) => s.step)

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex-1 flex flex-col">
        {step === 'connected' ? <FilmClerbStudioV2 /> : <AuthFlow />}
      </div>
      <Toasts />
    </div>
  )
}
