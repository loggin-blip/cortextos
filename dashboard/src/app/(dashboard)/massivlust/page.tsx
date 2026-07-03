import Link from 'next/link';
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
  { name: 'Breivikveien 14B', status: 'AKTIV', phase: 'Bunnsviller', progress: 20, pl: 'Vegard' },
  { name: 'Verksgata 54', status: 'PLANLAGT', phase: 'Planlegging', progress: 0, pl: 'Eivind' },
];

const TEAM_SUMMARY = { total: 18, active: 12, available: 5 };

const KS_SUMMARY = { total: 8, godkjent: 4, pending: 3, avvik: 1 };

const ACTIVITY = [
  { time: '09:37', text: 'KS-bilde-bekreftelse sendt til Vegard' },
  { time: '09:18', text: 'Vegard sendte 2 KS-bilder (Bunnsviller)' },
  { time: '08:30', text: 'Avvik #006: spec-tolkning (loest paa stedet)' },
  { time: '07:00', text: 'Morgenrapport sendt til Alex' },
];

export default function MassivlustDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Massivlust</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Prosjekt-oversikt og operasjonell status
        </p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{PROJECTS.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Aktive prosjekter</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{TEAM_SUMMARY.active}/{TEAM_SUMMARY.total}</div>
            <p className="text-xs text-muted-foreground mt-1">Team aktiv</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{KS_SUMMARY.total}</div>
            <p className="text-xs text-muted-foreground mt-1">KS-bilder i dag</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-amber-700">{KS_SUMMARY.avvik}</div>
            <p className="text-xs text-muted-foreground mt-1">Aapne avvik</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Projects */}
        <div className="lg:col-span-3 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Prosjekter</h2>
            <Link href="/massivlust/prosjekter" className="text-xs text-primary hover:underline">
              Se alle
            </Link>
          </div>
          {PROJECTS.map((project) => (
            <Card key={project.name}>
              <CardContent className="pt-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="font-medium">{project.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">PL: {project.pl} &middot; {project.phase}</p>
                  </div>
                  <Badge variant={project.status === 'AKTIV' ? 'default' : 'secondary'}>
                    {project.status}
                  </Badge>
                </div>
                <Progress value={project.progress} className="h-1.5" />
                <p className="text-[10px] text-muted-foreground mt-1.5">{project.progress}% ferdig</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Activity */}
        <div className="lg:col-span-2">
          <h2 className="text-sm font-medium mb-4">Siste aktivitet</h2>
          <Card>
            <CardContent className="pt-5">
              <div className="space-y-4">
                {ACTIVITY.map((item, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="text-[11px] text-muted-foreground font-mono shrink-0 pt-0.5">{item.time}</span>
                    <p className="text-sm leading-snug">{item.text}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* KS status */}
          <h2 className="text-sm font-medium mt-6 mb-4">KS-status</h2>
          <Card>
            <CardContent className="pt-5">
              <div className="flex justify-between items-center">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-xs">Godkjent: {KS_SUMMARY.godkjent}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    <span className="text-xs">Pending: {KS_SUMMARY.pending}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    <span className="text-xs">Avvik: {KS_SUMMARY.avvik}</span>
                  </div>
                </div>
                <Link href="/massivlust/ks" className="text-xs text-primary hover:underline">
                  Se alle
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
