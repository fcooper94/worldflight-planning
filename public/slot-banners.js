/* ===============================
   TIME HELPERS
================================ */

function pad(n) {
  return String(n).padStart(2, '0');
}



function addMinutesUtc(time, mins) {
  if (!time) return '';
  var parts = time.split(':');
  if (parts.length !== 2) return '';

  var d = new Date(Date.UTC(2000, 0, 1, Number(parts[0]), Number(parts[1])));
  d.setUTCMinutes(d.getUTCMinutes() + mins);

  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

function buildWindow(centerUtc) {
  if (!centerUtc) return '—';
  return addMinutesUtc(centerUtc, -60) + '–' + addMinutesUtc(centerUtc, 60);
}

/* ===============================
   RENDER SLOT BANNERS (GLOBAL)
================================ */

window.loadSlotBanners = function (data) {
  if (!data) return;

if (data.arrival && !data.arrival.dep_time_utc) return;
if (data.departure && !data.departure.dep_time_utc) return;


   var arrivalBookUrl =
  '/book?' +
  'from=' + encodeURIComponent(data.arrival.from) +
  '&to=' + encodeURIComponent(data.arrival.to) +
  '&dateUtc=' + encodeURIComponent(data.arrival.date) +
  '&depTimeUtc=' + encodeURIComponent(data.arrival.dep_time_utc);



  var departureBookUrl =
  '/book?' +
  'from=' + encodeURIComponent(data.departure.from) +
  '&to=' + encodeURIComponent(data.departure.to) +
  '&dateUtc=' + encodeURIComponent(data.departure.date) +
  '&depTimeUtc=' + encodeURIComponent(data.departure.dep_time_utc);

  var container = document.getElementById('slotBanners');
  if (!container) return;

  container.innerHTML = '';

  /* ---------- ARRIVAL ---------- */
  if (data.arrival) {
    var arrivalWindow = data.arrival.arr_time_utc
      ? buildWindow(data.arrival.arr_time_utc)
      : '—';

    container.innerHTML +=
  '<div class="slot-banner arrival">' +

    '<div class="slot-header">' +
      '<span class="slot-badge arrival">Arrival - </span>' +
      '<span class="slot-date">' + data.arrival.date + '</span>' +
    '</div>' +

    '<div class="slot-route">' +
      '<span>' + data.arrival.from + '</span>' +
      '<span class="arrow">→</span>' +
      '<span>' + data.arrival.to + '</span>' +
    '</div>' +

    '<div class="slot-window">' +
      '<span class="label">Arrival window (UTC): </span>' +
      '<span class="time" style="font-weight:bold;">' + arrivalWindow + '</span>' +
    '</div>' +

    '<div class="slot-atc">' +
      '<span class="label">ATC Route</span>' +
      '<span class="route-text">' + data.arrival.atcRoute + '</span>' +
    '</div>' +

    '<a class="wf-book-btn arrival" href="' + arrivalBookUrl + '">' +
  'Book arrival slot' +
'</a>'
;

  }

  /* ---------- DEPARTURE ---------- */
  if (data.departure) {
    var departureWindow =
      data.departure.depWindow ||
      (data.departure.dep_time_utc
        ? buildWindow(data.departure.dep_time_utc)
        : '—');

    container.innerHTML +=
  '<div class="slot-banner departure">' +

    '<div class="slot-header">' +
      '<span class="slot-badge departure">Departure - </span>' +
      '<span class="slot-date">' + data.departure.date + '</span>' +
    '</div>' +

    '<div class="slot-route">' +
      '<span>' + data.departure.from + '</span>' +
      '<span class="arrow">→</span>' +
      '<span>' + data.departure.to + '</span>' +
    '</div>' +

    '<div class="slot-window">' +
      '<span class="label">Departure window (UTC): </span>' +
      '<span class="time" style="font-weight:bold;">' + departureWindow + '</span>' +
    '</div>' +

    '<div class="slot-atc">' +
      '<span class="label">ATC route</span>' +
      '<span class="route-text">' + data.departure.atcRoute + '</span>' +
    '</div>' +

    '<a class="wf-book-btn departure" href="' + departureBookUrl + '">' +
  'Book departure slot' +
'</a>'
;

  }
};

/* ===============================
   AUTO LOAD (GLOBAL ICAO)
================================ */

document.addEventListener('DOMContentLoaded', function () {
  var parts = window.location.pathname.split('/');
  var icao = parts[parts.length - 1].toUpperCase();

  fetch('/api/icao/' + icao + '/wf-slots')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      window.loadSlotBanners(data);
    })
    .catch(function (err) {
      console.error('Failed to load slot banners', err);
    });
});
