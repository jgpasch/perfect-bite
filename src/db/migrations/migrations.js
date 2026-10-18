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
import m0014 from './0014_household_staples.sql';
import m0015 from './0015_recipe_steps.sql';
import m0016 from './0016_ingredient_links.sql';
import m0017 from './0017_household_combine_languages.sql';
import m0018 from './0018_meal_plan.sql';
import m0019 from './0019_step_ingredients.sql';
import m0020 from './0020_household_member_names.sql';
import m0021 from './0021_recipe_photo_path.sql';
import m0022 from './0022_recipe_photo_credit.sql';
import m0023 from './0023_item_photo_path.sql';
import m0024 from './0024_recipe_source_pages.sql';

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
m0013,
m0014,
m0015,
m0016,
m0017,
m0018,
m0019,
m0020,
m0021,
m0022,
m0023,
m0024
    }
  }
  