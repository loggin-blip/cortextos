import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

const MY_DATA = {
  name: 'Sondre M.',
  role: 'Montor',
  thisWeek: 40,
  thisMonth: 160,
  myProjects: [
    { name: 'Breivikveien 14B', phase: 'Bunnsviller', myDays: '27.04 — 02.05' },
  ],
  myCalendar: [
    { date: 'Man 28.04', project: 'Breivikveien 14B', task: 'Bunnsviller', hours: 8 },
    { date: 'Tir 29.04', project: 'Breivikveien 14B', task: 'Bunnsviller', hours: 8 },
    { date: 'Ons 30.04', project: 'Breivikveien 14B', task: 'Bunnsviller', hours: 8 },
    { date: 'Tor 01.05', project: 'Helligdag', task: '—', hours: 0 },
    { date: 'Fre 02.05', project: 'Breivikveien 14B', task: 'Bunnsviller', hours: 8 },
    { date: 'Man 05.05', project: 'Breivikveien 14B', task: 'Reisverk', hours: 8 },
    { date: 'Tir 06.05', project: 'Breivikveien 14B', task: 'Reisverk', hours: 8 },
    { date: 'Ons 07.05', project: 'Breivikveien 14B', task: 'Reisverk', hours: 8 },
    { date: 'Tor 08.05', project: 'Breivikveien 14B', task: 'Reisverk', hours: 8 },
    { date: 'Fre 09.05', project: 'Breivikveien 14B', task: 'Reisverk', hours: 8 },
  ],
  ksDone: 4,
  ksMissing: 2,
  ksRecent: [
    { label: 'Bunnsvill SO', date: '27.04', status: 'godkjent' },
    { label: 'Bunnsvill V', date: '27.04', status: 'godkjent' },
    { label: 'Diagonal-sjekk', date: '27.04', status: 'pending' },
    { label: 'Eksisterende vegg', date: '23.04', status: 'godkjent' },
  ],
};

export default function MinSidePage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center text-lg font-semibold text-primary">
          SM
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{MY_DATA.name}</h1>
          <p className="text-sm text-muted-foreground">{MY_DATA.role}</p>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{MY_DATA.thisWeek}</div>
            <p className="text-xs text-muted-foreground mt-1">Timer denne uka</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{MY_DATA.thisMonth}</div>
            <p className="text-xs text-muted-foreground mt-1">Timer denne mnd</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-emerald-700">{MY_DATA.ksDone}</div>
            <p className="text-xs text-muted-foreground mt-1">KS-bilder sendt</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-amber-700">{MY_DATA.ksMissing}</div>
            <p className="text-xs text-muted-foreground mt-1">KS mangler</p>
          </CardContent>
        </Card>
      </div>

      {/* Calendar */}
      <Card>
        <CardHeader>
          <CardTitle>Min kalender</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {MY_DATA.myCalendar.map((day, i) => (
              <div
                key={i}
                className={`flex items-center gap-4 px-3 py-2.5 rounded-lg ${
                  day.hours === 0 ? 'bg-muted/30 text-muted-foreground' : 'hover:bg-muted/50'
                }`}
              >
                <span className="text-xs font-mono w-20 shrink-0">{day.date}</span>
                <span className="text-sm flex-1">{day.project}</span>
                <span className="text-xs text-muted-foreground">{day.task}</span>
                <span className="text-xs font-mono w-8 text-right">
                  {day.hours > 0 ? `${day.hours}t` : '—'}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* My projects */}
      <Card>
        <CardHeader>
          <CardTitle>Mine prosjekter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {MY_DATA.myProjects.map((proj, i) => (
              <div key={i} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium">{proj.name}</p>
                  <p className="text-xs text-muted-foreground">Fase: {proj.phase}</p>
                </div>
                <span className="text-xs text-muted-foreground font-mono">{proj.myDays}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* My KS images */}
      <Card>
        <CardHeader>
          <CardTitle>Mine KS-bilder</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {MY_DATA.ksRecent.map((img, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                    <span className="text-[10px] text-muted-foreground">KS</span>
                  </div>
                  <div>
                    <p className="text-sm">{img.label}</p>
                    <p className="text-xs text-muted-foreground">{img.date}</p>
                  </div>
                </div>
                <Badge
                  variant="secondary"
                  className={
                    img.status === 'godkjent'
                      ? 'bg-emerald-500/10 text-emerald-700'
                      : 'bg-amber-500/10 text-amber-700'
                  }
                >
                  {img.status}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Report incident button */}
      <button className="w-full py-3 rounded-xl border-2 border-dashed border-muted-foreground/20 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
        + Rapporter avvik
      </button>
    </div>
  );
}
