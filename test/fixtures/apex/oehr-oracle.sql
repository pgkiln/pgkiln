-- (sprint 192, NX-F5) The OEHR tables of APEX's sample application "Demonstration - HR" (f77536.sql) with a few
-- rows, in Oracle: the columns the export uses, in the types of Oracle's HR and OE samples. scripts/oracle-e2e.sh runs
-- it in Oracle Database Free as user OEHR, moves it to PostgreSQL with ora2pg and imports f77536.sql on top.
-- test/fixtures/apex/oehr-postgres.sql is what ora2pg makes of it (for the unit test, without Oracle).

create table oehr_regions (
  region_id   number constraint oehr_regions_pk primary key,
  region_name varchar2(25)
);
create table oehr_countries (
  country_id   char(2) constraint oehr_countries_pk primary key,
  country_name varchar2(40),
  region_id    number references oehr_regions
);
create table oehr_locations (
  location_id    number(4) constraint oehr_locations_pk primary key,
  street_address varchar2(40),
  postal_code    varchar2(12),
  city           varchar2(30) not null,
  state_province varchar2(25),
  country_id     char(2) references oehr_countries
);
create table oehr_warehouses (
  warehouse_id   number(3) constraint oehr_warehouses_pk primary key,
  warehouse_name varchar2(35),
  location_id    number(4) references oehr_locations
);
create table oehr_jobs (
  job_id     varchar2(10) constraint oehr_jobs_pk primary key,
  job_title  varchar2(35) not null,
  min_salary number(6),
  max_salary number(6)
);
create table oehr_departments (
  department_id   number(4) constraint oehr_departments_pk primary key,
  department_name varchar2(30) not null,
  manager_id      number(6),
  location_id     number(4) references oehr_locations
);
create table oehr_employees (
  employee_id    number(6) constraint oehr_employees_pk primary key,
  first_name     varchar2(20),
  last_name      varchar2(25) not null,
  email          varchar2(25) not null,
  phone_number   varchar2(20),
  hire_date      date not null,
  job_id         varchar2(10) not null references oehr_jobs,
  salary         number(8,2),
  commission_pct number(2,2),
  manager_id     number(6) references oehr_employees,
  department_id  number(4) references oehr_departments
);
create table oehr_customers (
  customer_id     number(6) constraint oehr_customers_pk primary key,
  cust_first_name varchar2(20) not null,
  cust_last_name  varchar2(20) not null,
  street_address  varchar2(40),
  postal_code     varchar2(10),
  city            varchar2(30),
  state_province  varchar2(10),
  country_id      char(2),
  phone_number    varchar2(25),
  nls_language    varchar2(3),
  nls_territory   varchar2(30),
  credit_limit    number(9,2),
  cust_email      varchar2(30),
  account_mgr_id  number(6) references oehr_employees
);
create table oehr_product_information (
  product_id          number(6) constraint oehr_product_information_pk primary key,
  product_name        varchar2(50),
  product_description varchar2(2000),
  category_id         number(2),
  weight_class        number(1),
  warranty_period     interval year(2) to month,
  supplier_id         number(6),
  product_status      varchar2(20),
  list_price          number(8,2),
  min_price           number(8,2),
  catalog_url         varchar2(50)
);
create view oehr_products as
  select product_id, product_name, product_description, category_id, weight_class, warranty_period, supplier_id,
         product_status, list_price, min_price, catalog_url
    from oehr_product_information;
create table oehr_orders (
  order_id     number(12) constraint oehr_orders_pk primary key,
  order_date   timestamp with local time zone not null,
  order_mode   varchar2(8),
  customer_id  number(6) not null references oehr_customers,
  order_status number(2),
  order_total  number(8,2),
  sales_rep_id number(6) references oehr_employees,
  promotion_id number(6)
);
create table oehr_order_items (
  order_item_id number(12) constraint oehr_order_items_pk primary key,
  order_id      number(12) not null references oehr_orders,
  line_item_id  number(3) not null,
  product_id    number(6) not null references oehr_product_information,
  unit_price    number(8,2),
  quantity      number(8)
);
create sequence oehr_orders_seq start with 2460;

insert into oehr_regions values (1, 'Europe');
insert into oehr_regions values (2, 'Americas');
insert into oehr_countries values ('NL', 'Netherlands', 1);
insert into oehr_countries values ('US', 'United States of America', 2);
insert into oehr_locations values (1700, '2004 Charade Rd', '98199', 'Seattle', 'Washington', 'US');
insert into oehr_locations values (3100, 'Schwanthalerstr. 7031', '80925', 'Utrecht', 'Utrecht', 'NL');
insert into oehr_warehouses values (1, 'Southlake, Texas', 1700);
insert into oehr_jobs values ('AD_PRES', 'President', 20080, 40000);
insert into oehr_jobs values ('SA_REP', 'Sales Representative', 6000, 12008);
insert into oehr_departments values (90, 'Executive', null, 1700);
insert into oehr_departments values (80, 'Sales', null, 3100);
insert into oehr_employees values (100, 'Steven', 'King', 'SKING', '515.123.4567', date '2003-06-17', 'AD_PRES', 24000, null, null, 90);
insert into oehr_employees values (150, 'Peter', 'Tucker', 'PTUCKER', '011.44.1344.129268', date '2005-01-30', 'SA_REP', 10000, 0.3, 100, 80);
insert into oehr_customers values (101, 'Constantin', 'Welles', '514 W Superior St', '46901', 'Kokomo', 'IN', 'US', '+1 317 123 4104', 'us', 'AMERICA', 100, 'Constantin.Welles@example.com', 150);
insert into oehr_customers values (102, 'Harrison', 'Pacino', '2515 Bloyd Ave', '46218', 'Indianapolis', 'IN', 'US', '+1 317 123 4111', 'us', 'AMERICA', 100, 'Harrison.Pacino@example.com', 150);
insert into oehr_product_information values (3355, 'HD 8GB /SE', '8GB capacity hard disk drive', 13, 1, interval '2' year, 102050, 'orderable', 388, 362, 'http://www.example.com');
insert into oehr_product_information values (2254, 'HD 10GB /I', '10GB capacity hard disk drive', 13, 1, interval '1' year, 102071, 'obsolete', 453, 371, 'http://www.example.com');
insert into oehr_orders values (2458, timestamp '2024-08-16 23:34:12', 'direct', 101, 0, 78279.6, 150, null);
insert into oehr_orders values (2459, timestamp '2024-09-01 10:20:00', 'online', 102, 2, 1001.5, 150, null);
insert into oehr_order_items values (1, 2458, 1, 3355, 388, 2);
insert into oehr_order_items values (2, 2459, 1, 2254, 453, 1);
commit;
