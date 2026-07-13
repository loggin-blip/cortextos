import { notFound } from 'next/navigation';
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

type Employee = {
  id: string;
  full_name: string | null;
  role: string | null;
  active: boolean | null;
};

type Krav = {
  navn: string;
  kind: string | null;
  pakrevd: boolean;
  gyldighet_maneder: number | null;
  drive_file_id: string | null;
  aliases: string[] | null;
};

type KursRow = {
  id: string;
  navn: string;
  utsteder: string | null;
  bestaatt_dato: string | null;
  utlopsdato: string | null;
  sertifikat_url: string | null;
  notater: string | null;
};

type KompetanseRow = {
  navn: string;
  pakrevd: boolean;
  kind: string | null;
  status: 'bestått' | 'utløper snart' | 'utløpt' | 'mangler';
  bestaatt_dato: string | null;
  utlopsdato: string | null;
  sertifikat_url: string | null;
};

const ORG_ID = 'massivlust';

function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.MASSIVLUST_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key =
    process.env.MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function fetchJson<T>(url: string, key: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function classifyStatus(
  krav: Krav,
  kurs: KursRow | undefined,
): KompetanseRow['status'] {
  if (!kurs) return 'mangler';
  const hasProof = Boolean(kurs.sertifikat_url) || Boolean(kurs.bestaatt_dato);
  if (!hasProof) return 'mangler';
  const utl = kurs.utlopsdato;
  if (!utl) return 'bestått';
  try {
    const utlDate = new Date(utl);
    const today = new Date();
    const diffDays =
      (utlDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0) return 'utløpt';
    if (diffDays < 30) return 'utløper snart';
    return 'bestått';
  } catch {
    return 'bestått';
  }
}

function statusBadgeClass(s: KompetanseRow['status']): string {
  switch (s) {
    case 'bestått':
      return 'bg-emerald-500/10 text-emerald-700';
    case 'utløper snart':
      return 'bg-amber-500/10 text-amber-700';
    case 'utløpt':
      return 'bg-red-500/10 text-red-700';
    case 'mangler':
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function matchKurs(krav: Krav, kurs: KursRow[]): KursRow | undefined {
  const names = new Set([krav.navn, ...(krav.aliases ?? [])]);
  return kurs.find((k) => names.has(k.navn));
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  try {
    return d.slice(0, 10);
  } catch {
    return d;
  }
}

export default async function AnsattProfilPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Validate UUID-ish (basic)
  if (!/^[a-f0-9-]{20,}$/i.test(id)) {
    notFound();
  }

  const env = supabaseEnv();

  if (!env) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Ansatt-profil</h1>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Supabase-konfigurasjon mangler. Sett{' '}
              <code className="text-xs">MASSIVLUST_SUPABASE_URL</code> og{' '}
              <code className="text-xs">
                MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY
              </code>{' '}
              i dashboard-miljøet.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const empEncoded = encodeURIComponent(id);
  const [employeeRows, kravRows, kursRows] = await Promise.all([
    fetchJson<Employee[]>(
      `${env.url}/rest/v1/massivlust_employees?id=eq.${empEncoded}&select=id,full_name,role,active`,
      env.key,
    ),
    fetchJson<Krav[]>(
      `${env.url}/rest/v1/massivlust_kompetanse_krav?org_id=eq.${ORG_ID}&select=navn,kind,pakrevd,gyldighet_maneder,drive_file_id,aliases&order=pakrevd.desc,kind.asc,navn.asc`,
      env.key,
    ),
    fetchJson<KursRow[]>(
      `${env.url}/rest/v1/massivlust_kurs?org_id=eq.${ORG_ID}&employee_id=eq.${empEncoded}&select=id,navn,utsteder,bestaatt_dato,utlopsdato,sertifikat_url,notater`,
      env.key,
    ),
  ]);

  const emp = employeeRows?.[0];
  if (!emp) {
    notFound();
  }

  const krav = kravRows ?? [];
  const kurs = kursRows ?? [];

  const rows: KompetanseRow[] = krav.map((k) => {
    const match = matchKurs(k, kurs);
    return {
      navn: k.navn,
      pakrevd: k.pakrevd,
      kind: k.kind,
      status: classifyStatus(k, match),
      bestaatt_dato: match?.bestaatt_dato ?? null,
      utlopsdato: match?.utlopsdato ?? null,
      sertifikat_url: match?.sertifikat_url ?? null,
    };
  });

  const pakrevd = rows.filter((r) => r.pakrevd);
  const valgfri = rows.filter((r) => !r.pakrevd);

  const bestattCount = rows.filter((r) => r.status === 'bestått').length;
  const manglerPakrevd = pakrevd.filter((r) => r.status !== 'bestått').length;

  const initials = (emp.full_name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center text-lg font-semibold text-primary">
          {initials || '?'}
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {emp.full_name ?? 'Ukjent ansatt'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {emp.role ?? 'ukjent rolle'}
            {emp.active === false && ' · inaktiv'}
          </p>
        </div>
      </div>

      {/* Kompetanse summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{rows.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Kurs totalt</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold text-emerald-700">
              {bestattCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Bestått</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div
              className={`text-2xl font-semibold ${
                manglerPakrevd > 0 ? 'text-red-700' : 'text-emerald-700'
              }`}
            >
              {manglerPakrevd}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Mangler (pakrevd)
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-semibold">{pakrevd.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Pakrevde krav
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Pakrevde */}
      <Card>
        <CardHeader>
          <CardTitle>Pakrevde kurs</CardTitle>
          <CardDescription>
            Signert PDF er beviset — klikk lenken for å åpne
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kurs</TableHead>
                  <TableHead>Kilde</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Bestått</TableHead>
                  <TableHead>Utløper</TableHead>
                  <TableHead>Sertifikat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pakrevd.map((r) => (
                  <TableRow key={r.navn}>
                    <TableCell className="font-medium">{r.navn}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.kind ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={statusBadgeClass(r.status)}
                      >
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fmtDate(r.bestaatt_dato)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fmtDate(r.utlopsdato)}
                    </TableCell>
                    <TableCell>
                      {r.sertifikat_url ? (
                        <a
                          href={r.sertifikat_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary text-xs hover:underline"
                        >
                          Åpne PDF
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Valgfri */}
      {valgfri.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Valgfrie kurs</CardTitle>
            <CardDescription>
              Ikke pakrevd — logges hvis relevant for rolle
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kurs</TableHead>
                    <TableHead>Kilde</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Bestått</TableHead>
                    <TableHead>Utløper</TableHead>
                    <TableHead>Sertifikat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {valgfri.map((r) => (
                    <TableRow key={r.navn}>
                      <TableCell className="font-medium">{r.navn}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.kind ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={statusBadgeClass(r.status)}
                        >
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {fmtDate(r.bestaatt_dato)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {fmtDate(r.utlopsdato)}
                      </TableCell>
                      <TableCell>
                        {r.sertifikat_url ? (
                          <a
                            href={r.sertifikat_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary text-xs hover:underline"
                          >
                            Åpne PDF
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
