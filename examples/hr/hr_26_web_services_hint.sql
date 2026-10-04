-- HR page 23: the hint named the wrong setting format (the port is part of the host, and the
-- private-hosts list alone allows a host).
update meta.region r set source =
  '<p>The regions below read the HR REST API through <b>REST data sources</b> (Shared Components). The server only calls hosts it allows: to try it on your own machine, set <code>PGAPEX_REST_PRIVATE_HOSTS=127.0.0.1:3100</code> (the host and port of this server; a private address also needs this list, which allows the host too) and restart the server.</p>'
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 23 and r.title = 'About this page';
