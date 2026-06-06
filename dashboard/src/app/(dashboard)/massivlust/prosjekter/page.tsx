import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

export const dynamic = 'force-dynamic';

const PROJECTS = [
  {
    id: 'breivik',
    name: 'Breivikveien 14B',
    status: 'AKTIV',
    pl: 'Vegard',
    team: ['Vegard', 'Eivind', 'Sondre'],
    phase: 'Bunnsviller',
    phaseDay: '2/5',
    ksImages: '3/8',
    progress: 20,
    timeline: [
      { phase: 'Riving', days: 2, status: 'done' },
      { phase: 'Bunnsviller', days: 5, status: 'active' },
      { phase: 'Reisverk', days: 4, status: 'pending' },
      { phase: 'Tak', days: 3, status: 'pending' },
      { phase: 'Kledning', days: 5, status: 'pending' },
      { phase: 'Innvendig', days: 6, status: 'pending' },
    ],
    incidents: [{ date: '27.04 08:30', text: 'Materialleveranse forsinket 1t — loest' }],
  },
  {
    id: 'verks',
    name: 'Verksgata 54',
    status: 'PLANLAGT',
    pl: 'Eivind',
    team: ['TBD'],
    phase: 'Planlegging',
    phaseDay: '—',
    ksImages: '0/0',
    progress: 0,
    timeline: [
      { phase: 'Riving', days: 3, status: 'pending' },
      { phase: 'Bunnsviller', days: 4, status: 'pending' },
      { phase: 'Reisverk', days: 5, status: 'pending' },
    ],
    incidents: [],
  },
];

function phaseColor(status: string) {
  switch (status) {
    case 'done': return 'bg-emerald-500';
    case 'active': return 'bg-orange-500';
    default: return 'bg-muted';
  }
}

function statusBadge(status: string) {
  switch (status) {
    case 'AKTIV': return 'default';
    case 'PLANLAGT': return 'secondary';
    default: return 'outline';
  }
}

export default function MassivlustProsjekterPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Prosjekter</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Aktive og planlagte byggeprosjekter
        </p>
      </div>

      <div className="space-y-6">
        {PROJECTS.map((project) => (
          <Card key={project.id}>
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-lg">{project.name}</CardTitle>
                  <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                    <span>PL: <span className="font-medium text-foreground">{project.pl}</span></span>
                    <span>Team: {project.team.join(', ')}</span>
                  </div>
                </div>
                <Badge variant={statusBadge(project.status) as 'default' | 'secondary' | 'outline'}>
                  {project.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Progress */}
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-muted-foreground">Fase: <span className="font-medium text-foreground">{project.phase}</span> (dag {project.phaseDay})</span>
                    <span className="text-muted-foreground">KS-bilder: {project.ksImages}</span>
                  </div>
                  <Progress value={project.progress} className="h-2" />
                </div>
                <span className="text-sm font-medium w-10 text-right">{project.progress}%</span>
              </div>

              {/* Timeline */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-3">TIDSLINJE</p>
                <div className="flex gap-1">
                  {project.timeline.map((phase, i) => (
                    <div key={i} className="flex-1 min-w-0">
                      <div className={`h-2 rounded-full ${phaseColor(phase.status)}`} />
                      <p className="text-[10px] text-muted-foreground mt-1 truncate">{phase.phase}</p>
                      <p className="text-[10px] text-muted-foreground/60">{phase.days}d</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Incidents */}
              {project.incidents.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">AVVIK</p>
                  <div className="space-y-1">
                    {project.incidents.map((inc, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="text-muted-foreground font-mono shrink-0">{inc.date}</span>
                        <span>{inc.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
