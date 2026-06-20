import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

// Placeholder data — will be replaced with Supabase queries
const kapasitetData = [
  {
    id: 1,
    navn: 'Vegard',
    rolle: 'Montør',
    uke: '19',
    mandag: 'ledig',
    tirsdag: 'ledig',
    onsdag: 'ledig',
    torsdag: 'syk',
    fredag: 'syk',
  },
  {
    id: 2,
    navn: 'Martin',
    rolle: 'Montør',
    uke: '19',
    mandag: 'booket',
    tirsdag: 'booket',
    onsdag: 'ledig',
    torsdag: 'ledig',
    fredag: 'ledig',
  },
  {
    id: 3,
    navn: 'Mathias',
    rolle: 'Leder',
    uke: '19',
    mandag: 'booket',
    tirsdag: 'ledig',
    onsdag: 'ledig',
    torsdag: 'ledig',
    fredag: 'booket',
  },
];

const pengerData = [
  {
    id: 1,
    navn: 'Verksgata 54 - Renovering',
    fase: 'Pågår',
    inntekt: 450000,
    utgift: 320000,
  },
  {
    id: 2,
    navn: 'Holbergs Gate - Elektro',
    fase: 'Planlegging',
    inntekt: 280000,
    utgift: 0,
  },
  {
    id: 3,
    navn: 'Ferner Jacobsens - VVS',
    fase: 'Avsluttet',
    inntekt: 195000,
    utgift: 165000,
  },
];

const prosjekterData = [
  {
    id: 1,
    navn: 'Verksgata 54 - Renovering',
    fase: 'Pågår',
    startDato: '2026-04-15',
    sluttDato: '2026-06-30',
    kapasitetBehov: '2-3 montører',
    status: 'on-track',
  },
  {
    id: 2,
    navn: 'Holbergs Gate - Elektro',
    fase: 'Planlegging',
    startDato: '2026-05-01',
    sluttDato: '2026-07-15',
    kapasitetBehov: '1-2 elektrikere',
    status: 'on-track',
  },
  {
    id: 3,
    navn: 'Ferner Jacobsens - VVS',
    fase: 'Avsluttet',
    startDato: '2026-02-01',
    sluttDato: '2026-04-20',
    kapasitetBehov: '1 rørlegger',
    status: 'completed',
  },
];

function getStatusColor(status: string) {
  switch (status) {
    case 'ledig':
      return 'bg-green-500/10 text-green-700 dark:text-green-400';
    case 'booket':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-400';
    case 'syk':
      return 'bg-red-500/10 text-red-700 dark:text-red-400';
    default:
      return 'bg-gray-500/10 text-gray-700 dark:text-gray-400';
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'ledig':
      return 'Ledig';
    case 'booket':
      return 'Booket';
    case 'syk':
      return 'Syk';
    default:
      return status;
  }
}

function getFaseColor(fase: string) {
  switch (fase) {
    case 'Pågår':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-400';
    case 'Planlegging':
      return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400';
    case 'Avsluttet':
      return 'bg-green-500/10 text-green-700 dark:text-green-400';
    default:
      return 'bg-gray-500/10 text-gray-700 dark:text-gray-400';
  }
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('nb-NO', {
    style: 'currency',
    currency: 'NOK',
    minimumFractionDigits: 0,
  }).format(amount);
}

export default async function MassivlustPage() {
  // TODO: Data kommer fra Supabase
  // const { data: availability } = await supabase
  //   .from('massivlust_availability')
  //   .select('*')
  //   .gte('week', currentWeek);
  //
  // const { data: projects } = await supabase
  //   .from('massivlust_projects')
  //   .select('*');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Massivlust Operasjoner</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Oversikt over kapasitet, økonomi og prosjekter
        </p>
      </div>

      {/* Tabs for three panels */}
      <Tabs defaultValue="kapasitet">
        <TabsList>
          <TabsTrigger value="kapasitet">Kapasitet</TabsTrigger>
          <TabsTrigger value="penger">Økonomi</TabsTrigger>
          <TabsTrigger value="prosjekter">Prosjekter</TabsTrigger>
        </TabsList>

        {/* Panel 1: Kapasitet */}
        <TabsContent value="kapasitet">
          <Card>
            <CardHeader>
              <CardTitle>Kapasitet oversikt</CardTitle>
              <CardDescription>
                Tilgjengelighet per person for uke 19
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Navn</TableHead>
                      <TableHead>Rolle</TableHead>
                      <TableHead>Mandag</TableHead>
                      <TableHead>Tirsdag</TableHead>
                      <TableHead>Onsdag</TableHead>
                      <TableHead>Torsdag</TableHead>
                      <TableHead>Fredag</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {kapasitetData.map((person) => (
                      <TableRow key={person.id}>
                        <TableCell className="font-medium">
                          {person.navn}
                        </TableCell>
                        <TableCell>{person.rolle}</TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={getStatusColor(person.mandag)}
                          >
                            {getStatusLabel(person.mandag)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={getStatusColor(person.tirsdag)}
                          >
                            {getStatusLabel(person.tirsdag)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={getStatusColor(person.onsdag)}
                          >
                            {getStatusLabel(person.onsdag)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={getStatusColor(person.torsdag)}
                          >
                            {getStatusLabel(person.torsdag)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={getStatusColor(person.fredag)}
                          >
                            {getStatusLabel(person.fredag)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Panel 2: Økonomi */}
        <TabsContent value="penger">
          <Card>
            <CardHeader>
              <CardTitle>Prosjekt-økonomi</CardTitle>
              <CardDescription>
                Inntekt, utgift og margin per prosjekt
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {pengerData.map((projekt) => {
                  const margin = projekt.inntekt - projekt.utgift;
                  const marginProsent =
                    projekt.inntekt > 0
                      ? Math.round((margin / projekt.inntekt) * 100)
                      : 0;

                  return (
                    <div
                      key={projekt.id}
                      className="flex items-start justify-between border-b border-border pb-4 last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{projekt.navn}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          <Badge
                            variant="secondary"
                            className={getFaseColor(projekt.fase)}
                          >
                            {projekt.fase}
                          </Badge>
                        </p>
                      </div>
                      <div className="ml-4 text-right">
                        <div className="text-xs space-y-1">
                          <div className="text-muted-foreground">
                            Inntekt: {formatCurrency(projekt.inntekt)}
                          </div>
                          <div className="text-muted-foreground">
                            Utgift: {formatCurrency(projekt.utgift)}
                          </div>
                          <div className="font-medium">
                            Margin: {formatCurrency(margin)} ({marginProsent}%)
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Panel 3: Prosjekter */}
        <TabsContent value="prosjekter">
          <Card>
            <CardHeader>
              <CardTitle>Prosjekter</CardTitle>
              <CardDescription>
                Status, fase og kapasitetsbehov
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {prosjekterData.map((projekt) => (
                  <div
                    key={projekt.id}
                    className="flex flex-col gap-3 border-b border-border pb-4 last:border-0"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium text-sm">{projekt.navn}</p>
                        <div className="flex gap-2 mt-2">
                          <Badge
                            variant="secondary"
                            className={getFaseColor(projekt.fase)}
                          >
                            {projekt.fase}
                          </Badge>
                          {projekt.status === 'on-track' && (
                            <Badge
                              variant="secondary"
                              className="bg-green-500/10 text-green-700 dark:text-green-400"
                            >
                              On track
                            </Badge>
                          )}
                          {projekt.status === 'completed' && (
                            <Badge
                              variant="secondary"
                              className="bg-gray-500/10 text-gray-700 dark:text-gray-400"
                            >
                              Ferdig
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <div>
                        <span className="font-medium text-foreground">
                          Periode:
                        </span>{' '}
                        {new Date(projekt.startDato).toLocaleDateString(
                          'nb-NO'
                        )}{' '}
                        -{' '}
                        {new Date(projekt.sluttDato).toLocaleDateString(
                          'nb-NO'
                        )}
                      </div>
                      <div>
                        <span className="font-medium text-foreground">
                          Kapasitetsbehov:
                        </span>{' '}
                        {projekt.kapasitetBehov}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
