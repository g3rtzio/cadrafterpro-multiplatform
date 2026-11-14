import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TakeoffTree } from './takeoff-tree';

describe('TakeoffTree', () => {
  let component: TakeoffTree;
  let fixture: ComponentFixture<TakeoffTree>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TakeoffTree],
    }).compileComponents();

    fixture = TestBed.createComponent(TakeoffTree);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
