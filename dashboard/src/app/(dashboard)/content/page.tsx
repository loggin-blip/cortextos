import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

const VIDEOS = {
  script: [
    { title: 'Mikrosement bad — foer/etter', date: '28.04' },
    { title: 'Vedlikeholdstips uke 18', date: '29.04' },
  ],
  filmed: [
    { title: 'Kjokkenbenk-installasjon', date: '26.04' },
    { title: 'Trapp-overlegg', date: '25.04' },
  ],
  edited: [{ title: 'Gulv-applikasjon timelapse', date: '24.04' }],
  published: [
    { title: 'Komplett bad-renovering', date: '22.04', views: 12400, clicks: 340, sales: 4 },
    { title: 'Mikrosement vs flis', date: '20.04', views: 8900, clicks: 210, sales: 2 },
    { title: 'Verktoey-oversikt', date: '18.04', views: 5600, clicks: 120, sales: 1 },
  ],
};

const CALENDAR = [
  { day: 'Man', date: '28', items: [{ title: 'Mikrosement bad', status: 'planned' }] },
  { day: 'Tir', date: '29', items: [{ title: 'Vedlikehold', status: 'planned' }] },
  { day: 'Ons', date: '30', items: [] },
  { day: 'Tor', date: '01', items: [{ title: 'Kjokkenbenk', status: 'planned' }] },
  { day: 'Fre', date: '02', items: [] },
  { day: 'Lor', date: '03', items: [] },
  { day: 'Son', date: '04', items: [] },
];

function stageBadge(stage: string) {
  switch (stage) {
    case 'script': return { label: 'Script', color: 'bg-blue-500/10 text-blue-700' };
    case 'filmed': return { label: 'Filmet', color: 'bg-purple-500/10 text-purple-700' };
    case 'edited': return { label: 'Redigert', color: 'bg-amber-500/10 text-amber-700' };
    case 'published': return { label: 'Publisert', color: 'bg-emerald-500/10 text-emerald-700' };
    default: return { label: stage, color: 'bg-muted text-muted-foreground' };
  }
}

export default function ContentPage() {
  const totalPipeline = VIDEOS.script.length + VIDEOS.filmed.length + VIDEOS.edited.length;
  const totalPublished = VIDEOS.published.length;
  const totalViews = VIDEOS.published.reduce((s, v) => s + v.views, 0);
  const totalSales = VIDEOS.published.reduce((s, v) => s + v.sales, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Content OS</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Video-pipeline og publiserings-kalender (Leons prosjekt)
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{totalPipeline}</div>
            <p className="text-xs text-muted-foreground mt-1">I pipeline</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{totalPublished}</div>
            <p className="text-xs text-muted-foreground mt-1">Publisert</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{totalViews.toLocaleString('nb-NO')}</div>
            <p className="text-xs text-muted-foreground mt-1">Visninger totalt</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-emerald-700">{totalSales}</div>
            <p className="text-xs text-muted-foreground mt-1">Salg fra content</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pipeline */}
        <div className="lg:col-span-2 space-y-4">
          {(['script', 'filmed', 'edited', 'published'] as const).map((stage) => {
            const items = VIDEOS[stage];
            const { label, color } = stageBadge(stage);
            return (
              <Card key={stage}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{label}</CardTitle>
                    <Badge variant="secondary" className={color}>{items.length}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {items.map((item, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5">
                        <span className="text-sm">{item.title}</span>
                        <div className="flex items-center gap-3">
                          {'views' in item && (
                            <span className="text-xs text-muted-foreground font-mono">
                              {(item as { views: number }).views.toLocaleString('nb-NO')} views
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground font-mono">{item.date}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Calendar */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Publiserings-kalender</CardTitle>
            <CardDescription>Denne uka</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {CALENDAR.map((day) => (
                <div
                  key={day.date}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                    day.items.length > 0 ? 'bg-primary/5' : ''
                  }`}
                >
                  <div className="text-center w-10">
                    <p className="text-[10px] text-muted-foreground">{day.day}</p>
                    <p className="text-sm font-medium">{day.date}</p>
                  </div>
                  <div className="flex-1">
                    {day.items.length > 0 ? (
                      day.items.map((item, i) => (
                        <p key={i} className="text-sm">{item.title}</p>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">—</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
