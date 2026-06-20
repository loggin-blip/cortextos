import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

const KS_GALLERY = [
  { id: 1, project: 'Breivikveien 14B', phase: 'Bunnsviller', date: '27.04', author: 'Sondre M.', status: 'godkjent', label: 'Bunnsvill SO' },
  { id: 2, project: 'Breivikveien 14B', phase: 'Bunnsviller', date: '27.04', author: 'Sondre M.', status: 'godkjent', label: 'Bunnsvill V' },
  { id: 3, project: 'Breivikveien 14B', phase: 'Bunnsviller', date: '27.04', author: 'Vegard H.', status: 'pending', label: 'Vater-sjekk' },
  { id: 4, project: 'Breivikveien 14B', phase: 'Riving', date: '24.04', author: 'Eivind R.', status: 'godkjent', label: 'Riving ferdig' },
  { id: 5, project: 'Breivikveien 14B', phase: 'Riving', date: '23.04', author: 'Sondre M.', status: 'godkjent', label: 'Eksisterende vegg' },
  { id: 6, project: 'Breivikveien 14B', phase: 'Riving', date: '23.04', author: 'Vegard H.', status: 'avvik', label: 'Raate oppdaget' },
  { id: 7, project: 'Breivikveien 14B', phase: 'Bunnsviller', date: '27.04', author: 'Alex K.', status: 'pending', label: 'Forankring' },
  { id: 8, project: 'Breivikveien 14B', phase: 'Bunnsviller', date: '27.04', author: 'Sondre M.', status: 'pending', label: 'Diagonal-sjekk' },
];

function statusBadgeColor(status: string) {
  switch (status) {
    case 'godkjent': return 'bg-emerald-500/10 text-emerald-700';
    case 'pending': return 'bg-amber-500/10 text-amber-700';
    case 'avvik': return 'bg-red-500/10 text-red-700';
    default: return 'bg-muted text-muted-foreground';
  }
}

export default function MassivlustKsPage() {
  const godkjent = KS_GALLERY.filter(k => k.status === 'godkjent').length;
  const pending = KS_GALLERY.filter(k => k.status === 'pending').length;
  const avvik = KS_GALLERY.filter(k => k.status === 'avvik').length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">KS-oversikt</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {KS_GALLERY.length} bilder &middot; {godkjent} godkjent &middot; {pending} venter &middot; {avvik} avvik
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-emerald-700">{godkjent}</div>
            <p className="text-xs text-muted-foreground mt-1">Godkjent</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-amber-700">{pending}</div>
            <p className="text-xs text-muted-foreground mt-1">Venter godkjenning</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-red-700">{avvik}</div>
            <p className="text-xs text-muted-foreground mt-1">Avvik</p>
          </CardContent>
        </Card>
      </div>

      {/* Image grid */}
      <Card>
        <CardHeader>
          <CardTitle>Alle KS-bilder</CardTitle>
          <CardDescription>Sortert etter dato, nyeste foerst</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {KS_GALLERY.map((img) => (
              <div key={img.id} className="group border rounded-xl overflow-hidden hover:shadow-md transition-shadow">
                {/* Placeholder for actual image */}
                <div className="aspect-[4/3] bg-muted flex items-center justify-center">
                  <div className="text-center px-3">
                    <p className="text-xs font-medium text-muted-foreground">{img.label}</p>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">{img.phase}</p>
                  </div>
                </div>
                <div className="p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">{img.date}</span>
                    <Badge variant="secondary" className={`text-[10px] ${statusBadgeColor(img.status)}`}>
                      {img.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{img.author}</p>
                  <p className="text-[10px] text-muted-foreground/60 truncate">{img.project}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
