-- (sprint 192, NX-F5) What ora2pg 25.0 makes of oehr-oracle.sql (TABLE, SEQUENCE, VIEW, INSERT and the foreign keys
-- after the data, FILE_PER_FKEYS 1), with ora2pg's SET search_path, CREATE SCHEMA, OWNER and psql lines left out:
-- the unit test (test/apex-import.test.ts) runs it in a schema of its own. scripts/oracle-e2e.sh makes it from Oracle.
-- One hand edit: ora2pg 25.0's INSERT export writes INTERVAL values unquoted (+02-00); quoted here. Its COPY export is right.

-- ora2pg -t TABLE

CREATE TABLE oehr_countries (
	country_id char(2) NOT NULL,
	country_name varchar(40),
	region_id bigint
) ;
ALTER TABLE oehr_countries ADD PRIMARY KEY (country_id);

CREATE TABLE oehr_customers (
	customer_id integer NOT NULL,
	cust_first_name varchar(20) NOT NULL,
	cust_last_name varchar(20) NOT NULL,
	street_address varchar(40),
	postal_code varchar(10),
	city varchar(30),
	state_province varchar(10),
	country_id char(2),
	phone_number varchar(25),
	nls_language varchar(3),
	nls_territory varchar(30),
	credit_limit decimal(9,2),
	cust_email varchar(30),
	account_mgr_id integer
) ;
ALTER TABLE oehr_customers ADD PRIMARY KEY (customer_id);
ALTER TABLE oehr_customers ALTER COLUMN cust_first_name SET NOT NULL;
ALTER TABLE oehr_customers ALTER COLUMN cust_last_name SET NOT NULL;

CREATE TABLE oehr_departments (
	department_id smallint NOT NULL,
	department_name varchar(30) NOT NULL,
	manager_id integer,
	location_id smallint
) ;
ALTER TABLE oehr_departments ADD PRIMARY KEY (department_id);
ALTER TABLE oehr_departments ALTER COLUMN department_name SET NOT NULL;

CREATE TABLE oehr_employees (
	employee_id integer NOT NULL,
	first_name varchar(20),
	last_name varchar(25) NOT NULL,
	email varchar(25) NOT NULL,
	phone_number varchar(20),
	hire_date timestamp(0) NOT NULL,
	job_id varchar(10) NOT NULL,
	salary decimal(8,2),
	commission_pct decimal(2,2),
	manager_id integer,
	department_id smallint
) ;
ALTER TABLE oehr_employees ADD PRIMARY KEY (employee_id);
ALTER TABLE oehr_employees ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE oehr_employees ALTER COLUMN email SET NOT NULL;
ALTER TABLE oehr_employees ALTER COLUMN hire_date SET NOT NULL;
ALTER TABLE oehr_employees ALTER COLUMN job_id SET NOT NULL;

CREATE TABLE oehr_jobs (
	job_id varchar(10) NOT NULL,
	job_title varchar(35) NOT NULL,
	min_salary integer,
	max_salary integer
) ;
ALTER TABLE oehr_jobs ADD PRIMARY KEY (job_id);
ALTER TABLE oehr_jobs ALTER COLUMN job_title SET NOT NULL;

CREATE TABLE oehr_locations (
	location_id smallint NOT NULL,
	street_address varchar(40),
	postal_code varchar(12),
	city varchar(30) NOT NULL,
	state_province varchar(25),
	country_id char(2)
) ;
ALTER TABLE oehr_locations ADD PRIMARY KEY (location_id);
ALTER TABLE oehr_locations ALTER COLUMN city SET NOT NULL;

CREATE TABLE oehr_orders (
	order_id bigint NOT NULL,
	order_date TIMESTAMP(6) WITH TIME ZONE NOT NULL,
	order_mode varchar(8),
	customer_id integer NOT NULL,
	order_status smallint,
	order_total decimal(8,2),
	sales_rep_id integer,
	promotion_id integer
) ;
ALTER TABLE oehr_orders ADD PRIMARY KEY (order_id);
ALTER TABLE oehr_orders ALTER COLUMN order_date SET NOT NULL;
ALTER TABLE oehr_orders ALTER COLUMN customer_id SET NOT NULL;

CREATE TABLE oehr_order_items (
	order_item_id bigint NOT NULL,
	order_id bigint NOT NULL,
	line_item_id smallint NOT NULL,
	product_id integer NOT NULL,
	unit_price decimal(8,2),
	quantity integer
) ;
ALTER TABLE oehr_order_items ADD PRIMARY KEY (order_item_id);
ALTER TABLE oehr_order_items ALTER COLUMN order_id SET NOT NULL;
ALTER TABLE oehr_order_items ALTER COLUMN line_item_id SET NOT NULL;
ALTER TABLE oehr_order_items ALTER COLUMN product_id SET NOT NULL;

CREATE TABLE oehr_product_information (
	product_id integer NOT NULL,
	product_name varchar(50),
	product_description varchar(2000),
	category_id smallint,
	weight_class smallint,
	warranty_period INTERVAL YEAR TO MONTH,
	supplier_id integer,
	product_status varchar(20),
	list_price decimal(8,2),
	min_price decimal(8,2),
	catalog_url varchar(50)
) ;
ALTER TABLE oehr_product_information ADD PRIMARY KEY (product_id);

CREATE TABLE oehr_regions (
	region_id bigint NOT NULL,
	region_name varchar(25)
) ;
ALTER TABLE oehr_regions ADD PRIMARY KEY (region_id);

CREATE TABLE oehr_warehouses (
	warehouse_id smallint NOT NULL,
	warehouse_name varchar(35),
	location_id smallint
) ;
ALTER TABLE oehr_warehouses ADD PRIMARY KEY (warehouse_id);

-- ora2pg -t SEQUENCE

CREATE SEQUENCE oehr_orders_seq INCREMENT 1 MINVALUE 1 NO MAXVALUE START 2460 CACHE 20;

-- ora2pg -t VIEW

CREATE OR REPLACE VIEW oehr_products (product_id, product_name, product_description, category_id, weight_class, warranty_period, supplier_id, product_status, list_price, min_price, catalog_url) AS select product_id, product_name, product_description, category_id, weight_class, warranty_period, supplier_id,
         product_status, list_price, min_price, catalog_url
    FROM oehr_product_information;


-- ora2pg -t INSERT

INSERT INTO oehr_countries (country_id,country_name,region_id) VALUES (E'NL',E'Netherlands',1);
INSERT INTO oehr_countries (country_id,country_name,region_id) VALUES (E'US',E'United States of America',2);

INSERT INTO oehr_customers (customer_id,cust_first_name,cust_last_name,street_address,postal_code,city,state_province,country_id,phone_number,nls_language,nls_territory,credit_limit,cust_email,account_mgr_id) VALUES (101,E'Constantin',E'Welles',E'514 W Superior St',E'46901',E'Kokomo',E'IN',E'US',E'+1 317 123 4104',E'us',E'AMERICA',100,E'Constantin.Welles@example.com',150);
INSERT INTO oehr_customers (customer_id,cust_first_name,cust_last_name,street_address,postal_code,city,state_province,country_id,phone_number,nls_language,nls_territory,credit_limit,cust_email,account_mgr_id) VALUES (102,E'Harrison',E'Pacino',E'2515 Bloyd Ave',E'46218',E'Indianapolis',E'IN',E'US',E'+1 317 123 4111',E'us',E'AMERICA',100,E'Harrison.Pacino@example.com',150);

INSERT INTO oehr_departments (department_id,department_name,manager_id,location_id) VALUES (90,E'Executive',NULL,1700);
INSERT INTO oehr_departments (department_id,department_name,manager_id,location_id) VALUES (80,E'Sales',NULL,3100);

INSERT INTO oehr_employees (employee_id,first_name,last_name,email,phone_number,hire_date,job_id,salary,commission_pct,manager_id,department_id) VALUES (100,E'Steven',E'King',E'SKING',E'515.123.4567','2003-06-17 00:00:00',E'AD_PRES',24000,NULL,NULL,90);
INSERT INTO oehr_employees (employee_id,first_name,last_name,email,phone_number,hire_date,job_id,salary,commission_pct,manager_id,department_id) VALUES (150,E'Peter',E'Tucker',E'PTUCKER',E'011.44.1344.129268','2005-01-30 00:00:00',E'SA_REP',10000,.3,100,80);

INSERT INTO oehr_jobs (job_id,job_title,min_salary,max_salary) VALUES (E'AD_PRES',E'President',20080,40000);
INSERT INTO oehr_jobs (job_id,job_title,min_salary,max_salary) VALUES (E'SA_REP',E'Sales Representative',6000,12008);

INSERT INTO oehr_locations (location_id,street_address,postal_code,city,state_province,country_id) VALUES (1700,E'2004 Charade Rd',E'98199',E'Seattle',E'Washington',E'US');
INSERT INTO oehr_locations (location_id,street_address,postal_code,city,state_province,country_id) VALUES (3100,E'Schwanthalerstr. 7031',E'80925',E'Utrecht',E'Utrecht',E'NL');

INSERT INTO oehr_orders (order_id,order_date,order_mode,customer_id,order_status,order_total,sales_rep_id,promotion_id) VALUES (2458,'2024-08-16 23:34:12',E'direct',101,0,78279.6,150,NULL);
INSERT INTO oehr_orders (order_id,order_date,order_mode,customer_id,order_status,order_total,sales_rep_id,promotion_id) VALUES (2459,'2024-09-01 10:20:00',E'online',102,2,1001.5,150,NULL);

INSERT INTO oehr_order_items (order_item_id,order_id,line_item_id,product_id,unit_price,quantity) VALUES (1,2458,1,3355,388,2);
INSERT INTO oehr_order_items (order_item_id,order_id,line_item_id,product_id,unit_price,quantity) VALUES (2,2459,1,2254,453,1);

INSERT INTO oehr_product_information (product_id,product_name,product_description,category_id,weight_class,warranty_period,supplier_id,product_status,list_price,min_price,catalog_url) VALUES (3355,E'HD 8GB /SE',E'8GB capacity hard disk drive',13,1,'+02-00',102050,E'orderable',388,362,E'http://www.example.com');
INSERT INTO oehr_product_information (product_id,product_name,product_description,category_id,weight_class,warranty_period,supplier_id,product_status,list_price,min_price,catalog_url) VALUES (2254,E'HD 10GB /I',E'10GB capacity hard disk drive',13,1,'+01-00',102071,E'obsolete',453,371,E'http://www.example.com');

INSERT INTO oehr_regions (region_id,region_name) VALUES (1,E'Europe');
INSERT INTO oehr_regions (region_id,region_name) VALUES (2,E'Americas');

INSERT INTO oehr_warehouses (warehouse_id,warehouse_name,location_id) VALUES (1,E'Southlake, Texas',1700);


-- foreign keys (FKEYS_table.sql)

ALTER TABLE oehr_countries ADD CONSTRAINT sys_c008719 FOREIGN KEY (region_id) REFERENCES oehr_regions(region_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE oehr_customers ADD CONSTRAINT sys_c008741 FOREIGN KEY (account_mgr_id) REFERENCES oehr_employees(employee_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE oehr_departments ADD CONSTRAINT sys_c008729 FOREIGN KEY (location_id) REFERENCES oehr_locations(location_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE oehr_employees ADD CONSTRAINT sys_c008735 FOREIGN KEY (job_id) REFERENCES oehr_jobs(job_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE oehr_employees ADD CONSTRAINT sys_c008736 FOREIGN KEY (manager_id) REFERENCES oehr_employees(employee_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE oehr_employees ADD CONSTRAINT sys_c008737 FOREIGN KEY (department_id) REFERENCES oehr_departments(department_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE oehr_locations ADD CONSTRAINT sys_c008722 FOREIGN KEY (country_id) REFERENCES oehr_countries(country_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE oehr_orders ADD CONSTRAINT sys_c008746 FOREIGN KEY (customer_id) REFERENCES oehr_customers(customer_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE oehr_orders ADD CONSTRAINT sys_c008747 FOREIGN KEY (sales_rep_id) REFERENCES oehr_employees(employee_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE oehr_order_items ADD CONSTRAINT sys_c008752 FOREIGN KEY (order_id) REFERENCES oehr_orders(order_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE oehr_order_items ADD CONSTRAINT sys_c008753 FOREIGN KEY (product_id) REFERENCES oehr_product_information(product_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE oehr_warehouses ADD CONSTRAINT sys_c008724 FOREIGN KEY (location_id) REFERENCES oehr_locations(location_id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE;
