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

const PIPELINE = {
  leads: 223,
  contacted: 47,
  qualified: 12,
  proposal: 5,
  closed: 2,
};

const RECENT_LEADS = [
  { name: 'Fjordline Elektro AS', source: 'Shopify', status: 'Kontaktet', days: 2, value: '~45 000 NOK' },
  { name: 'Bergen Bygg & Renovering', source: 'Organisk', status: 'Kvalifisert', days: 5, value: '~120 000 NOK' },
  { name: 'Nordlys Rør & Varme', source: 'Shopify', status: 'Tilbud sendt', days: 8, value: '~85 000 NOK' },
  { name: 'Hammerfest Montasje', source: 'Shopify', status: 'Ny', days: 1, value: '~30 000 NOK' },
  { name: 'Solvik Trelast AS', source: 'Organisk', status: 'Kontaktet', days: 3, value: '~60 000 NOK' },
  { name: 'Kristiansand VVS Teknikk', source: 'Shopify', status: 'Kvalifisert', days: 6, value: '~95 000 NOK' },
];

const AGENT_STATUS = {
  name: 'nordflo-dev',
  status: 'blocked',
  blocker: 'Shopify API-tilgang (dag 5)',
  lastActivity: 'Idle — venter tilgang',
  uptime: '2d 1h',
  tasksCompleted: 14,
};

const METRICS = {
  mrrCurrent: 1800,
  mrrTarget: 15000,
  conversionRate: 2.2,
  avgDealSize: 67500,
  responseTime: '—',
};

function formatNok(n: number) {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', minimumFractionDigits: 0 }).format(n);
}

function statusColor(status: string) {
  switch (status) {
    case 'Ny': return 'bg-blue-500/10 text-blue-700';
    case 'Kontaktet': return 'bg-amber-500/10 text-amber-700';
    case 'Kvalifisert': return 'bg-purple-500/10 text-purple-700';
    case 'Tilbud sendt': return 'bg-orange-500/10 text-orange-700';
    case 'Lukket': return 'bg-emerald-500/10 text-emerald-700';
    default: return 'bg-muted text-muted-foreground';
  }
}

export default function NordfloPage() {
  const pipelineTotal = PIPELINE.leads;
  const pipelineStages = [
    { label: 'Leads', count: PIPELINE.leads, color: 'bg-blue-500' },
    { label: 'Kontaktet', count: PIPELINE.contacted, color: 'bg-amber-500' },
    { label: 'Kvalifisert', count: PIPELINE.qualified, color: 'bg-purple-500' },
    { label: 'Tilbud', count: PIPELINE.proposal, color: 'bg-orange-500' },
    { label: 'Lukket', count: PIPELINE.closed, color: 'bg-emerald-500' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Nordflo</h1>
          <p className="text-sm text-muted-foreground mt-1">
            CRM-pipeline og salgsmetrikker
          </p>
        </div>
        <Badge variant="secondary" className="bg-red-500/10 text-red-700">
          Agent blocked — Shopify dag 5
        </Badge>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{formatNok(METRICS.mrrCurrent)}</div>
            <p className="text-xs text-muted-foreground mt-1">MRR naa</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{formatNok(METRICS.mrrTarget)}</div>
            <p className="text-xs text-muted-foreground mt-1">MRR maal</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{METRICS.conversionRate}%</div>
            <p className="text-xs text-muted-foreground mt-1">Konvertering</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{formatNok(METRICS.avgDealSize)}</div>
            <p className="text-xs text-muted-foreground mt-1">Snitt deal</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{METRICS.responseTime}</div>
            <p className="text-xs text-muted-foreground mt-1">Svar-tid</p>
          </CardContent>
        </Card>
      </div>

      {/* MRR progress */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">MRR-progresjon</CardTitle>
          <CardDescription>
            {formatNok(METRICS.mrrCurrent)} av {formatNok(METRICS.mrrTarget)} ({Math.round((METRICS.mrrCurrent / METRICS.mrrTarget) * 100)}%)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={(METRICS.mrrCurrent / METRICS.mrrTarget) * 100} className="h-3" />
        </CardContent>
      </Card>

      {/* Pipeline funnel */}
      <Card>
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>Salgstrakt fra lead til lukket deal</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {pipelineStages.map((stage) => (
              <div key={stage.label} className="flex items-center gap-4">
                <span className="text-sm w-24 shrink-0 text-muted-foreground">{stage.label}</span>
                <div className="flex-1">
                  <div className="relative h-8 rounded-lg bg-muted/50 overflow-hidden">
                    <div
                      className={`absolute inset-y-0 left-0 ${stage.color} rounded-lg transition-all`}
                      style={{ width: `${Math.max(3, (stage.count / pipelineTotal) * 100)}%` }}
                    />
                    <span className="absolute inset-0 flex items-center px-3 text-sm font-medium">
                      {stage.count}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground font-mono w-12 text-right">
                  {((stage.count / pipelineTotal) * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent leads + Agent status side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Siste leads</CardTitle>
              <CardDescription>Nyeste leads i pipeline</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {RECENT_LEADS.map((lead, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{lead.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">{lead.source}</span>
                        <span className="text-xs text-muted-foreground">{lead.days}d siden</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs font-mono text-muted-foreground">{lead.value}</span>
                      <Badge variant="secondary" className={`text-[10px] ${statusColor(lead.status)}`}>
                        {lead.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Agent</CardTitle>
              <CardDescription>{AGENT_STATUS.name}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant="secondary" className="bg-red-500/10 text-red-700 text-[10px]">
                    {AGENT_STATUS.status}
                  </Badge>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Blocker</span>
                  <span className="text-xs text-right">{AGENT_STATUS.blocker}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Uptime</span>
                  <span className="text-xs font-mono">{AGENT_STATUS.uptime}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tasks ferdig</span>
                  <span className="text-xs font-mono">{AGENT_STATUS.tasksCompleted}</span>
                </div>
              </div>
              <div className="pt-2 border-t">
                <p className="text-xs text-muted-foreground">{AGENT_STATUS.lastActivity}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
