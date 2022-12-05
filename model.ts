import { DataTypes, Model } from "https://deno.land/x/denodb/mod.ts";

export class Version extends Model {
  static table = "versions";
  static timestamps = true;

  static fields = {
    id: { primaryKey: true, autoIncrement: true },
    channel: DataTypes.STRING,
    major: DataTypes.INTEGER,
    minor: DataTypes.INTEGER,
    patch: DataTypes.INTEGER,
    release: DataTypes.DATETIME,
  };
}
