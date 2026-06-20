import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

export const dynamic = 'force-dynamic';

const DELIVERABLES = [
  {
    id: 'massivlust-del',
    name: 'Massivlust',
    description: 'Byggebransje-system: prosjektstyring, KS, team, okonomi',
    status: 'AKTIV',
    phase: 'Execution',
    agents: ['kaptein-massivlust', 'ml-prosjektleder', 'massivlust-team', 'massivlust-dev'],
    agentHealth: 3,
    agentTotal: 4,
    mrr: 2200,
    tasksDone: 28,
    tasksActive: 4,
    blockers: ['12 Alex-beslutninger venter', 'Vegard W-489 ubesvart 3d'],
    lastActivity: 'Avvik #007+#008 Carsten-mail klar, venter Alex go',
    color: 'bg-orange-500',
  },
  {
    id: 'nordflo-del',
    name: 'Nordflo',
    description: 'Handverker-CRM: Shopify-integrasjon, salgspipeline, morgenbrief',
    status: 'BLOCKED',
    phase: 'Shopify-tilgang',
    agents: ['nordflo-dev'],
    agentHealth: 0,
    agentTotal: 1,
    mrr: 1800,
    tasksDone: 14,
    tasksActive: 0,
    blockers: ['Shopify API-tilgang dag 5'],
    lastActivity: 'Idle — venter Shopify-tilgang fra Max',
    color: 'bg-blue-500',
  },
  {
    id: 'robin-venture',
    name: 'Robin Venture',
    description: 'Vertikal SaaS: restaurant matsvinn + eiendom',
    status: 'TIDLIG',
    phase: 'Avklaring',
    agents: [],
    agentHealth: 0,
    agentTotal: 0,
    mrr: 0,
    tasksDone: 0,
    tasksActive: 0,
    blockers: ['Debrief fra mote 30.04 mangler'],
    lastActivity: 'Mote med Robin 30.04 kl 17 — ingen debrief enna',
    color: 'bg-violet-500',
  },
  {
    id: 'wda-content',
    name: 'WDA Content OS',
    description: 'Sosiale medier og innholdsproduksjon for WDA brand',
    status: 'PAUSE',
    phase: 'Smoke-test',
    agents: ['leon-personal'],
    agentHealth: 0,
    agentTotal: 1,
    mrr: 0,
    tasksDone: 6,
    tasksActive: 1,
    blockers: ['Blocked on Leon'],
    lastActivity: 'Smoke-test venter Leon-respons (6+ dager)',
    color: 'bg-amber-500',
  },
];

const REVENUE = {
  totalMRR: 4000,
  target: 100000,
  breakdown: [
    { client: 'Massivlust', amount: 2200, type: 'Retainer', growth: 0 },
    { client: 'Nordflo', amount: 1800, type: 'Retainer + provisjon', growth: 0 },
  ],
};

function formatNok(n: number) {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', minimumFractionDigits: 0 }).format(n);
}

function statusBadge(status: string) {
  switch (status) {
    case 'AKTIV': return 'bg-emerald-500/10 text-emerald-700';
    case 'BLOCKED': return 'bg-red-500/10 text-red-700';
    case 'TIDLIG': return 'bg-violet-500/10 text-violet-700';
    case 'PAUSE': return 'bg-amber-500/10 text-amber-700';
    default: return 'bg-muted text-muted-foreground';
  }
}

export default function ProsjekterPage() {
  const totalBlockers = DELIVERABLES.reduce((sum, d) => sum + d.blockers.length, 0);
  const mrrProgress = (REVENUE.totalMRR / REVENUE.target) * 100;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Prosjekter</h1>
        <p className="text-sm text-muted-foreground mt-1">
          WDA klient-leveranser og ventures — {totalBlockers} blokkere totalt
        </p>
      </div>

      {/* MRR overview */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">MRR: {formatNok(REVENUE.totalMRR)} / {formatNok(REVENUE.target)}</CardTitle>
              <CardDescription>Maal: {formatNok(REVENUE.target)} innen sommeren er over</CardDescription>
            </div>
            <span className="text-2xl font-semibold">{mrrProgress.toFixed(0)}%</span>
          </div>
        </CardHeader>
        <CardContent>
          <Progress value={mrrProgress} className="h-3" />
          <div className="flex gap-6 mt-4">
            {REVENUE.breakdown.map((item) => (
              <div key={item.client} className="flex items-baseline gap-2">
                <span className="text-sm font-medium">{formatNok(item.amount)}</span>
                <span className="text-xs text-muted-foreground">{item.client} ({item.type})</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Deliverable cards */}
      <div className="space-y-4">
        {DELIVERABLES.map((del) => (
          <Card key={del.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`h-3 w-3 rounded-full ${del.color}`} />
                  <div>
                    <CardTitle className="text-base">{del.name}</CardTitle>
                    <CardDescription className="mt-0.5">{del.description}</CardDescription>
                  </div>
                </div>
                <Badge variant="secondary" className={statusBadge(del.status)}>
                  {del.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Fase</p>
                  <p className="text-sm font-medium mt-0.5">{del.phase}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">MRR</p>
                  <p className="text-sm font-medium mt-0.5">{del.mrr > 0 ? formatNok(del.mrr) : '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Agenter</p>
                  <p className="text-sm font-medium mt-0.5">
                    {del.agentTotal > 0 ? `${del.agentHealth}/${del.agentTotal} OK` : 'Ingen'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Tasks</p>
                  <p className="text-sm font-medium mt-0.5">{del.tasksDone} ferdig, {del.tasksActive} aktive</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Blokkere</p>
                  <p className={`text-sm font-medium mt-0.5 ${del.blockers.length > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                    {del.blockers.length}
                  </p>
                </div>
              </div>

              {del.blockers.length > 0 && (
                <div className="mt-4 pt-3 border-t space-y-1">
                  {del.blockers.map((b, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                      <span className="text-muted-foreground">{b}</span>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
                {del.lastActivity}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
