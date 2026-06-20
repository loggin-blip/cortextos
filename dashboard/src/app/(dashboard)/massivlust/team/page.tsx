import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const TEAM = [
  { name: 'Vegard H.', role: 'Prosjektleder', status: 'aktiv', hours: { week: 38, month: 152 }, ksCount: 12, certs: { HMS: '2027-03', G11: '2026-09', Lift: '2026-12', Fallsikring: '2027-06' } },
  { name: 'Eivind R.', role: 'Prosjektleder', status: 'aktiv', hours: { week: 36, month: 148 }, ksCount: 9, certs: { HMS: '2027-01', G11: '2026-08', Lift: '2026-10', Fallsikring: '2027-04' } },
  { name: 'Sondre M.', role: 'Montor', status: 'aktiv', hours: { week: 40, month: 160 }, ksCount: 6, certs: { HMS: '2026-11', G11: '2026-07', Lift: '2026-09', Fallsikring: '2027-02' } },
  { name: 'Alex K.', role: 'Montor', status: 'aktiv', hours: { week: 32, month: 128 }, ksCount: 4, certs: { HMS: '2027-05', G11: '2026-12', Lift: '—', Fallsikring: '2026-11' } },
  { name: 'Tobias S.', role: 'Montor', status: 'aktiv', hours: { week: 0, month: 24 }, ksCount: 1, certs: { HMS: '2027-08', G11: '—', Lift: '—', Fallsikring: '2027-01' } },
  { name: 'Mathias O.', role: 'Laerling', status: 'aktiv', hours: { week: 24, month: 96 }, ksCount: 0, certs: { HMS: '2026-08', G11: '—', Lift: '—', Fallsikring: '2026-09' } },
  { name: 'Kristian B.', role: 'Montor', status: 'pause', hours: { week: 0, month: 0 }, ksCount: 2, certs: { HMS: '2026-09', G11: '2026-06', Lift: '2026-11', Fallsikring: '2026-08' } },
  { name: 'Henrik L.', role: 'Montor', status: 'aktiv', hours: { week: 16, month: 64 }, ksCount: 1, certs: { HMS: '2027-02', G11: '2026-10', Lift: '—', Fallsikring: '2026-12' } },
];

function statusColor(status: string) {
  switch (status) {
    case 'aktiv': return 'bg-emerald-500/10 text-emerald-700';
    case 'pause': return 'bg-amber-500/10 text-amber-700';
    case 'DNC': return 'bg-red-500/10 text-red-700';
    default: return 'bg-muted text-muted-foreground';
  }
}

function certStatus(dateStr: string) {
  if (dateStr === '—') return 'missing';
  if (dateStr === 'utlopt') return 'expired';
  const [year, month] = dateStr.split('-').map(Number);
  const expiry = new Date(year, month - 1);
  const now = new Date();
  const diffMonths = (expiry.getFullYear() - now.getFullYear()) * 12 + (expiry.getMonth() - now.getMonth());
  if (diffMonths < 0) return 'expired';
  if (diffMonths < 3) return 'warning';
  return 'ok';
}

function certBadgeColor(dateStr: string) {
  const status = certStatus(dateStr);
  switch (status) {
    case 'ok': return 'bg-emerald-500/10 text-emerald-700';
    case 'warning': return 'bg-amber-500/10 text-amber-700';
    case 'expired': return 'bg-red-500/10 text-red-700';
    default: return 'bg-muted text-muted-foreground';
  }
}

export default function MassivlustTeamPage() {
  const activeCount = TEAM.filter(t => t.status === 'aktiv').length;
  const totalHours = TEAM.reduce((sum, t) => sum + t.hours.week, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {TEAM.length} montoerer &middot; {activeCount} aktive &middot; {totalHours} timer denne uka
        </p>
      </div>

      {/* Team table */}
      <Card>
        <CardHeader>
          <CardTitle>Oversikt</CardTitle>
          <CardDescription>Timer, KS-bilder og sertifikat-status per person</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Navn</TableHead>
                  <TableHead>Rolle</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Timer/uke</TableHead>
                  <TableHead className="text-right">Timer/mnd</TableHead>
                  <TableHead className="text-right">KS-bilder</TableHead>
                  <TableHead>HMS</TableHead>
                  <TableHead>G11</TableHead>
                  <TableHead>Lift</TableHead>
                  <TableHead>Fallsikring</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TEAM.map((person) => (
                  <TableRow key={person.name}>
                    <TableCell className="font-medium">{person.name}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{person.role}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={statusColor(person.status)}>
                        {person.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{person.hours.week}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{person.hours.month}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{person.ksCount}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={`text-[10px] ${certBadgeColor(person.certs.HMS)}`}>
                        {person.certs.HMS}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={`text-[10px] ${certBadgeColor(person.certs.G11)}`}>
                        {person.certs.G11}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={`text-[10px] ${certBadgeColor(person.certs.Lift)}`}>
                        {person.certs.Lift}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={`text-[10px] ${certBadgeColor(person.certs.Fallsikring)}`}>
                        {person.certs.Fallsikring}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
