// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from './meta/_journal.json';
import m0000 from './0000_init.sql';
import m0001 from './0001_lists.sql';
import m0002 from './0002_categories.sql';
import m0003 from './0003_recipes.sql';
import m0004 from './0004_ingredient_usage.sql';
import m0005 from './0005_ingredient_unit_usage.sql';
import m0006 from './0006_sync_outbox.sql';
import m0007 from './0007_outbox_rejections.sql';
import m0008 from './0008_ingredient_default_unit.sql';
import m0009 from './0009_failed_imports.sql';
import m0010 from './0010_list_color.sql';
import m0011 from './0011_household_aisles.sql';
import m0012 from './0012_failed_import_target.sql';
import m0013 from './0013_recipe_tags.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008,
m0009,
m0010,
m0011,
m0012,
m0013
    }
  }
  