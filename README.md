# Rezerwacje premiery „Goła Zośka 1812”

Kod obejmuje wybór numerowanych miejsc, weryfikację e-maila, obowiązkowy telefon wpisany dwukrotnie (bez SMS), ponowne potwierdzenie udziału, listę rezerwową i panel organizatora. Zapisy pozostają zamknięte, dopóki nie zostaną skonfigurowane usługi i wykonany test dostarczenia prawdziwego e-maila.

## Otwarcie zapisów

Zapisy są zaplanowane na **5 listopada 2026 o godz. 00:00 Europe/Warsaw** (4 listopada 23:00 UTC). Obie publiczne funkcje sprawdzają czas serwera: przed startem formularz i bezpośrednie żądania rezerwacji pozostają zamknięte. Strona filmu i formularz podają datę rozpoczęcia. RESERVATIONS_OPEN=true oznacza uzbrojenie harmonogramu; false nadal umożliwia ręczne zamknięcie. Nie jest potrzebne zadanie dzienne, aktywny komputer ani nowe wdrożenie w dniu startu. Panel organizatora i obsługa wcześniejszych zgłoszeń pozostają dostępne.

## Wydarzenie i miejsca

21 listopada 2026, godz. 19:00, sala widowiskowa MDK, Rynek Zygmunta Augusta 9, wejście od ul. Kościelnej, II piętro. Strefa czasowa: Europe/Warsaw.

| Rząd | Miejsc | Pula |
|---|---:|---|
| 1 | 12 | organizacyjna |
| 2 | 13 | organizacyjna |
| 3 | 12 | organizacyjna |
| 4 | 13 | organizacyjna |
| 5 | 12 | 1–10 dostępne; 11–12 wstrzymane |
| 6 | 13 | 1–11 dostępne; 12–13 wstrzymane |
| 7 | 8 | 1–6 dostępne; 7–8 wstrzymane |

Łącznie 83 miejsca: 50 organizacyjnych, 27 dostępnych na początku, 6 do późniejszego wypuszczenia. Rząd 1 jest przy ekranie. Przyjęta numeracja na planie: od lewej do prawej, patrząc w stronę ekranu; organizator powinien sprawdzić ją względem numerów foteli przed otwarciem zapisów.

W jednym zgłoszeniu 1–4 miejsca, jeden aktywny zapis na e-mail. Ta sama blokada w bazie obejmuje wszystkie przydziały i zmiany puli, chroniąc przed podwójną rezerwacją. Wybrane miejsce zostaje zablokowane dopiero po przyjęciu formularza, nie po kliknięciu na planie. Konflikt wymaga ponownego wyboru.

## Terminy potwierdzeń

- E-mail trzeba sprawdzić przez link w ciągu 24 godzin. Wejście w link pokazuje przycisk; dopiero jego naciśnięcie potwierdza zgłoszenie, więc automatyczne skanery poczty nie potwierdzają udziału.
- Prośba o ponowne potwierdzenie udziału jest wysyłana od 14 listopada godz. 19:00.
- Termin ostateczny: **18 listopada 2026, godz. 19:00**, dokładnie 72 godziny przed pokazem. Wygasają wszystkie wcześniejsze niepotwierdzone rezerwacje, także gdy prośba o potwierdzenie nie została dostarczona.
- Potwierdzenie e-maila od 14 listopada godz. 19:00 od razu potwierdza udział.
- Nowe zgłoszenia od 18 listopada godz. 19:00 wymagają potwierdzenia e-maila w ciągu 24 godzin, najpóźniej do początku pokazu. Zapisy zamykają się na początku pokazu.
- Lista rezerwowa także wymaga weryfikacji e-maila w 24 godziny. Zadanie dzienne przydziela zwolnione fotele w kolejności zgłoszeń, pomijając grupy większe niż bieżąca liczba wolnych foteli. Preferuje miejsca obok siebie; gdy ich brak, oferta może obejmować rozdzielone miejsca. Oferta wskazuje numery i wygasa po 48 godzinach, najpóźniej na początku pokazu.
- 19 listopada zadanie dzienne zaczyna wysyłać przypomnienia potwierdzonym osobom. Nie obejmuje ono rezerwacji potwierdzonych dopiero po ostatnim zadaniu przed seansem; ich szczegóły są w wiadomości początkowej i pod linkiem zarządzania.

Zadanie Vercel działa raz dziennie o 18:00 UTC, czyli **19:00 w Polsce w listopadzie**. W planie Hobby uruchomienie może nastąpić z opóźnieniem w obrębie godziny. Wygasanie nie zależy tylko od zadania: odczyt planu, obsługa rezerwacji i panel uruchamiają kontrolę terminu, więc przeterminowane fotele wracają do dostępności przy następnej operacji. Oferty z listy rezerwowej i e-maile czekają na zadanie dzienne. Jeśli potrzebna jest wysyłka i automatyczne zadanie dokładnie o 19:00, należy dobrać plan lub zewnętrzny harmonogram przed otwarciem.

## Podłączenie usług i uruchomienie

1. Załóż **Neon Postgres**, najlepiej w regionie UE, i ustaw prywatne DATABASE_URL w Vercelu. W nowej bazie wykonaj db/schema.sql. Dla starej pustej instalacji użyj db/migrate-numbered-seats.sql. Migracja odmawia działania przy jakichkolwiek istniejących zgłoszeniach, aby nie zmienić przydziałów; wtedy potrzebne jest osobne uzgodnienie danych.
2. Załóż **Resend** i zweryfikuj domenę golazoska.com rekordami DNS wskazanymi przez usługę. Ustaw RESEND_API_KEY, MAIL_FROM=Goła Zośka <rezerwacje@golazoska.com> oraz MAIL_REPLY_TO=rezerwacje@golazoska.com. Skrzynkę do odbioru odpowiedzi trzeba utworzyć u operatora poczty – Resend jej nie tworzy. Nie zmieniaj rekordów MX domeny podczas weryfikowania nadawcy.
3. Utwórz **Cloudflare Turnstile** dla www.golazoska.com. Ustaw TURNSTILE_SITE_KEY oraz TURNSTILE_SECRET_KEY. PUBLIC_BASE_URL=https://www.golazoska.com i TURNSTILE_HOSTNAME=www.golazoska.com muszą odpowiadać domenie formularza. Upewnij się, że wejście przez golazoska.com przekierowuje na www, zanim widz zobaczy formularz.
4. Utwórz mocne, niezależne ADMIN_TOKEN i CRON_SECRET. Ten pierwszy chroni /organizator.html, drugi /api/cron. Zostaw RESERVATIONS_OPEN=false. Sekrety wpisuj w panelu Vercela; nie dodawaj ich do repozytorium ani rozmowy.
5. Sprawdź informację prywatności: administrator Krzysztof Przekop, kontakt rezerwacje@golazoska.com. Proponowany termin retencji: 21 grudnia 2026; zadanie od 22 grudnia usuwa dane z aktywnej bazy. Administrator usuwa osobno eksporty CSV i sprawdza retencję dostawców oraz zasady przekazywania danych po wyborze konkretnych usług.
6. Wykonaj test prawdziwego zapisu w osobnym środowisku z osobną bazą i kluczami: odbiór e-maila, kliknięcie, widok miejsc, anulowanie, telefon, konflikt rezerwacji, panel i lista rezerwowa. Sprawdź zadanie dzienne oraz dostarczanie i odbicia e-maili w Resend. Testy automatyczne używają atrapy wysyłki – nie potwierdzają dostarczalności.
7. Po testach ustaw RESERVATIONS_OPEN=true w produkcji i wdroż zmianę. Przed 5 listopada /api/status zwróci open:false i opensAt; od zaplanowanego startu zwróci open:true i plan 83 foteli.

## Obsługa organizatora

/organizator.html pokazuje nazwisko, e-mail, telefon, liczbę osób, konkretne miejsca i status. Eksport CSV zabezpiecza pola zaczynające się od znaków formuł arkusza. Klucz panelu jest trzymany tylko w pamięci strony.

Przyciski przy fotelach w rzędach 5–7 pozwalają udostępnić lub wstrzymać wolne miejsce. Zajętych foteli i puli organizacyjnej nie można w ten sposób przenieść. Zmiany są zapisywane w bazie i od razu widoczne przy odświeżeniu planu. Rzędy 1–4 obsługuj na osobnej liście organizacyjnej.

Ręczna propozycja dla zweryfikowanej listy rezerwowej przydziela fotele, a wiadomość wyśle zadanie dzienne. Potwierdzenie i anulowanie są dostępne dla odpowiednich statusów.

## Testy

Node.js 22 lub 24: npm install, następnie npm test. Testy korzystają z prawdziwego silnika Postgres w PGlite, sprawdzają granice czasowe, pule, konflikty, migrację, formularz w DOM i połączenie API z bazą. Wysyłka i zabezpieczenie Cloudflare są w testach zastępowane atrapami.

Testy nie zastępują sprawdzenia równoległych połączeń w Neon ani rzeczywistej wysyłki e-maili. Przed otwarciem trzeba jeszcze sprawdzić wybrane regiony i konfigurację usług. Publiczny status nie zwraca danych osobowych ani tokenów.
